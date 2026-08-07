package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed static
var staticFS embed.FS

func nowMS() int64 { return time.Now().UnixNano() / 1e6 }

// ---- config ----

type ConfigStore struct {
	mu     sync.RWMutex
	pollMS int
}

func NewConfigStore(pollMS int) *ConfigStore {
	if pollMS < 200 {
		pollMS = 200
	}
	return &ConfigStore{pollMS: pollMS}
}

func (c *ConfigStore) Get() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.pollMS
}

func (c *ConfigStore) Set(ms int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ms < 200 || ms > 30000 {
		return false
	}
	c.pollMS = ms
	return true
}

type configPayload struct {
	PollMS int `json:"poll_ms"`
}

func (c *ConfigStore) payload() configPayload {
	return configPayload{PollMS: c.Get()}
}

// ---- vLLM scraper (head only) ----

type vllmScraper struct {
	mu       sync.Mutex
	endpoint string
	prevTok  float64
	prevTime float64
	client   *http.Client
}

func newVLLMScraper(endpoint string) *vllmScraper {
	return &vllmScraper{
		endpoint: endpoint,
		client:   &http.Client{Timeout: 2 * time.Second},
	}
}

func lastNumber(s string) float64 {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[len(fields)-1], 64)
	return v
}

func (v *vllmScraper) scrape() *VLLM {
	var tokens, running float64
	resp, err := v.client.Get(v.endpoint)
	if err != nil {
		return &VLLM{Reachable: false, RunningRequests: -1, GenTokensRate: -1}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &VLLM{Reachable: false, RunningRequests: -1, GenTokensRate: -1}
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if strings.Contains(line, "vllm:generation_tokens_total") {
			tokens = lastNumber(line)
		}
		if strings.Contains(line, "vllm:num_requests_running") {
			running = lastNumber(line)
		}
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := float64(nowMS()) / 1000.0
	rate := float64(-1)
	if v.prevTime > 0 && tokens >= v.prevTok {
		dt := now - v.prevTime
		if dt > 0.2 {
			rate = (tokens - v.prevTok) / dt
		}
	}
	v.prevTok = tokens
	v.prevTime = now
	return &VLLM{Reachable: true, RunningRequests: running, GenTokensRate: rate}
}

// ---- server ----

type Server struct {
	cfg       *ConfigStore
	hub       *Hub
	collector *Collector
	demo      bool
	workerSSH *SSH
	worker    *workerState
	localRun  interface {
		Run(context.Context) (rawMetrics, error)
	}
	workerRun interface {
		Run(context.Context) (rawMetrics, error)
	}
	vllm *vllmScraper
}

type workerState struct {
	enabled  bool
	host     string
	port     string
	user     string
	insecure bool
	lastDial time.Time
}

func (s *Server) tick() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Head node (local or demo)
	src := sourceLocal
	if s.demo {
		src = sourceDemo
	}
	headRaw, err := s.localRun.Run(ctx)
	head := s.collector.Finalize("head", src, headRaw)
	if err != nil {
		head.Up = false
		head.Error = err.Error()
	}
	head.VLLM = s.vllm.scrape()
	s.publish(head)

	if s.worker.enabled {
		worker := s.pollWorker(ctx)
		s.publish(worker)
	}
}

func (s *Server) pollWorker(ctx context.Context) NodeMetrics {
	m := NodeMetrics{NodeID: "worker", TS: float64(nowMS()) / 1000.0, Source: sourceSSH}
	if s.demo {
		raw, err := s.workerRun.Run(ctx)
		m = s.collector.Finalize("worker", sourceDemo, raw)
		if err != nil {
			m.Up = false
			m.Error = err.Error()
		}
		return m
	}
	// Redirect stderr handling: worker ssh connection is reused across polls.
	if s.workerSSH == nil {
		if time.Since(s.worker.lastDial) < 10*time.Second {
			m.Up = false
			m.Error = "worker ssh not yet (re)connected"
			return m
		}
		s.worker.lastDial = time.Now()
		ssh, err := DialSSH(s.worker.host, s.worker.port, s.worker.user, s.worker.insecure)
		if err != nil {
			m.Up = false
			m.Error = "ssh connect: " + err.Error()
			return m
		}
		s.workerSSH = ssh
	}
	raw, err := s.workerSSH.Run(ctx)
	m = s.collector.Finalize("worker", sourceSSH, raw)
	if err != nil {
		m.Up = false
		m.Error = strings.TrimSpace(err.Error())
		// keep worker marked down; retry dial after a delay
		s.workerSSH.Close()
		s.workerSSH = nil
		s.worker.lastDial = time.Now()
	}
	return m
}

func (s *Server) publish(m NodeMetrics) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	s.hub.publish(sseFrame("metrics", string(b)))
}

// ---- HTTP ----

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no") // nginx SSE
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch, _ := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)

	cfg, _ := json.Marshal(s.cfg.payload())
	w.Write(sseFrame("hello", string(cfg)))
	fl.Flush()

	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			fl.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.cfg.payload())
	case http.MethodPost:
		var in configPayload
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if !s.cfg.Set(in.PollMS) {
			http.Error(w, "poll_ms must be 200..30000", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.cfg.payload())
		cfg, _ := json.Marshal(s.cfg.payload())
		s.hub.publish(sseFrame("config", string(cfg)))
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ---- env helpers ----

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string) bool {
	v := strings.ToLower(os.Getenv(k))
	return v == "1" || v == "true" || v == "yes"
}

// ---- seed providers ----

func seedRunners(demo bool) (local, worker interface {
	Run(context.Context) (rawMetrics, error)
}) {
	if demo {
		return NewDemoRunner(), NewDemoRunner()
	}
	return LocalRunner{}, nil
}

func main() {
	bind := envOr("DASH_BIND", "127.0.0.1:8088")
	pollMS := envInt("DASH_POLL_MS", 5000)
	demo := envBool("DASH_DEMO")
	vllmURL := envOr("DASH_VLLM_ENDPOINT", "http://127.0.0.1:8000/metrics")

	ws := &workerState{
		enabled:  !envBool("DASH_NO_WORKER"),
		host:     envOr("DASH_WORKER_IP", "192.168.100.11"),
		port:     envOr("DASH_WORKER_SSH_PORT", "22"),
		user:     envOr("DASH_WORKER_USER", "root"),
		insecure: envBool("DASH_INSECURE_SKIP_HOSTKEY"),
	}

	localRun, workerRun := seedRunners(demo)

	s := &Server{
		cfg:       NewConfigStore(pollMS),
		hub:       newHub(),
		collector: NewCollector(),
		demo:      demo,
		worker:    ws,
		localRun:  localRun,
		workerRun: workerRun,
		vllm:      newVLLMScraper(vllmURL),
	}

	// background poll loop
	go func() {
		for {
			interval := time.Duration(s.cfg.Get()) * time.Millisecond
			if interval < 200 {
				interval = 200
			}
			time.Sleep(interval)
			s.tick()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/metrics/push", s.handleSSE)
	mux.HandleFunc("/api/config", s.handleConfig)

	content, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(content)))

	mode := "local"
	if demo {
		mode = "demo"
	} else if ws.enabled {
		mode = "local+worker(" + ws.host + ")"
	}
	log.Printf("light-dgx-spark-cluster-dashboard listening on %s [%s] poll=%dms", bind, mode, s.cfg.Get())
	log.Fatal(http.ListenAndServe(bind, mux))
}
