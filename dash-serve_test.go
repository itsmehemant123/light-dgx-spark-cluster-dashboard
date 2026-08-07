package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sptr(f float64) *float64 { return &f }

func TestParseCollectOutput(t *testing.T) {
	out := `GPU|0,83,45,102400,46000,92,66,62,1185,1185,1100,GB10
ZONE|soc_thermal|95400
ZONE|cpu_thermal|91000
TEMP|soc_pkg|95.4
TEMP|gpu|66.0
POWER|sys_total|330
POWER|gpu_total|184
FAN|fan0|2100
MEM|201326592|123456789
CPU|1000|200|300|9000|100|50|20|10
CPUCLK|2400
NVME|52
`
	r := parseCollectOutput(out)
	if len(r.gpus) != 1 {
		t.Fatalf("want 1 gpu, got %d", len(r.gpus))
	}
	g := r.gpus[0]
	if g.Idx != 0 || g.UtilPct != 83 || g.MemPct != 45 || g.PowerW != 92 || g.TempC != 66 || g.MemTempC != 62 || g.Name != "GB10" {
		t.Errorf("gpu parsed wrong: %+v", g)
	}
	if len(r.zones) != 2 || r.zones[0].label != "soc_thermal" {
		t.Errorf("zones wrong: %+v", r.zones)
	}
	if r.temps["soc_pkg"] != 95.4 || r.powers["sys_total"] != 330 || r.fans["fan0"] != 2100 {
		t.Errorf("hwmon maps wrong: %+v %+v %+v", r.temps, r.powers, r.fans)
	}
	if r.memTotalKB != 201326592 || r.memAvailKB != 123456789 {
		t.Errorf("mem wrong: %v %v", r.memTotalKB, r.memAvailKB)
	}
	if r.cpu.total == 0 || r.cpu.idle == 0 {
		t.Errorf("cpu wrong: %+v", r.cpu)
	}
	if r.cpuClk == nil || *r.cpuClk != 2400 {
		t.Errorf("cpuclk wrong: %v", r.cpuClk)
	}
	if r.nvme == nil || *r.nvme != 52 {
		t.Errorf("nvme wrong: %v", r.nvme)
	}
}

func TestCollectorCPUAndSoc(t *testing.T) {
	c := NewCollector()
	raw := func(tot, idle float64) rawMetrics {
		return rawMetrics{memTotalKB: 1000, memAvailKB: 400, cpu: cpuTicks{total: tot, idle: idle}}
	}
	m1 := c.Finalize("head", sourceDemo, raw(1000, 900))
	if m1.CPUPct != 0 {
		t.Errorf("first sample should have 0 cpu pct, got %v", m1.CPUPct)
	}
	m2 := c.Finalize("head", sourceDemo, raw(2000, 950))
	// busy = (2000-1000)-(950-900) = 1000-50 = 950 of total 1000 => 95%
	if m2.CPUPct != 95 {
		t.Errorf("cpu pct want 95, got %v", m2.CPUPct)
	}
	if m2.RAM.Pct != 60 || m2.RAM.TotalMB != 0.9765625 {
		t.Errorf("ram wrong: %+v", m2.RAM)
	}
}

func TestFinalizeSocTemp(t *testing.T) {
	c := NewCollector()
	r := rawMetrics{zones: []tagVal{{label: "a", value: 90}, {label: "b", value: 96}}}
	m := c.Finalize("head", sourceDemo, r)
	if m.SocTempC == nil || *m.SocTempC != 96 {
		t.Errorf("soc temp want max 96, got %v", m.SocTempC)
	}
}

// test server harness
func newTestServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	s := &Server{
		cfg:       NewConfigStore(1000),
		hub:       newHub(),
		collector: NewCollector(),
		demo:      true,
		worker:    &workerState{enabled: true, host: "10.0.0.2", port: "22", user: "root"},
		vllm:      newVLLMScraper("http://127.0.0.1:1/metrics"),
	}
	s.localRun = NewDemoRunner()
	s.workerRun = NewDemoRunner()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/metrics/push", s.handleSSE)
	mux.HandleFunc("/api/config", s.handleConfig)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, s
}

func readEvent(br *bufio.Reader) (event, data string) {
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return event, data
		}
		line = strings.TrimRight(line, "\n")
		if line == "" {
			return event, data
		}
		if strings.HasPrefix(line, "event: ") {
			event = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			data = strings.TrimPrefix(line, "data: ")
		}
	}
}

func TestSSEStream(t *testing.T) {
	ts, s := newTestServer(t)
	resp, err := http.Get(ts.URL + "/api/metrics/push")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type want event-stream, got %q", ct)
	}
	if resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Errorf("want X-Accel-Buffering no")
	}
	br := bufio.NewReader(resp.Body)
	ev, data := readEvent(br)
	if ev != "hello" {
		t.Fatalf("first event want hello, got %q", ev)
	}
	var hello configPayload
	if err := json.Unmarshal([]byte(data), &hello); err != nil || hello.PollMS != 1000 {
		t.Errorf("hello payload wrong: %s err=%v", data, err)
	}
	// publish a metrics frame, then read it
	s.publish(NodeMetrics{NodeID: "head", TS: 1.0, Up: true})
	ev, data = readEvent(br)
	if ev != "metrics" {
		t.Fatalf("want metrics event, got %q", ev)
	}
	var m NodeMetrics
	if err := json.Unmarshal([]byte(data), &m); err != nil {
		t.Fatalf("bad metrics json: %v", err)
	}
	if m.NodeID != "head" || !m.Up {
		t.Errorf("metrics wrong: %+v", m)
	}
}

func TestConfigEndpoints(t *testing.T) {
	ts, _ := newTestServer(t)
	// initial
	resp, err := http.Get(ts.URL + "/api/config")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var c configPayload
	if err := json.Unmarshal(body, &c); err != nil || c.PollMS != 1000 {
		t.Errorf("initial config wrong: %s", body)
	}
	// set
	resp, err = http.Post(ts.URL+"/api/config", "application/json", strings.NewReader(`{"poll_ms":500}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if err := json.Unmarshal(body, &c); err != nil || c.PollMS != 500 {
		t.Errorf("after set config wrong: %s", body)
	}
	// invalid
	resp, _ = http.Post(ts.URL+"/api/config", "application/json", strings.NewReader(`{"poll_ms":10}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("want 400 for invalid poll_ms, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
