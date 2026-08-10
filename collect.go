package main

import (
	"bufio"
	"context"
	_ "embed"
	"os/exec"
	"strconv"
	"strings"
)

//go:embed collect_script.sh
var collectScript string

const (
	sourceLocal = "local:sysfs+nvidia-smi"
	sourceSSH   = "ssh:sysfs+nvidia-smi"
	sourceDemo  = "demo:synthetic"
)

// ---- JSON payload pushed over SSE (one per node per tick) ----

type GPU struct {
	Idx        int      `json:"idx"`
	UtilPct    float64  `json:"util_pct"`
	MemPct     *float64 `json:"mem_pct"`
	MemTotalMB *float64 `json:"mem_total_mb"`
	MemUsedMB  *float64 `json:"mem_used_mb"`
	PowerW     float64  `json:"power_w"`
	TempC      float64  `json:"temp_c"`
	MemTempC   *float64 `json:"mem_temp_c"`
	ClkGFXMHz  float64  `json:"clock_graphics_mhz"`
	ClkSMMHz   float64  `json:"clock_sm_mhz"`
	ClkMemMHz  *float64 `json:"clock_mem_mhz"`
	Name       string   `json:"name"`
}

type RAM struct {
	TotalMB float64 `json:"total_mb"`
	UsedMB  float64 `json:"used_mb"`
	Pct     float64 `json:"pct"`
}

type VLLM struct {
	Reachable       bool    `json:"reachable"`
	RunningRequests float64 `json:"running_requests"`
	GenTokensRate   float64 `json:"gen_tokens_rate"`
}

type NodeMetrics struct {
	NodeID    string             `json:"node_id"`
	TS        float64            `json:"ts"`
	Up        bool               `json:"up"`
	Error     string             `json:"error,omitempty"`
	Source    string             `json:"source"`
	GPU       []GPU              `json:"gpu"`
	SocTempC  *float64           `json:"soc_temp_c"`
	Zones     map[string]float64 `json:"zones,omitempty"`
	CPUPct    float64            `json:"cpu_pct"`
	CPUClkMHz *float64           `json:"cpu_clk_mhz"`
	RAM       RAM                `json:"ram"`
	Power     map[string]float64 `json:"power"` // hwmon power channels (may be empty = N/A)
	Temps     map[string]float64 `json:"temps"` // hwmon temp channels (may be empty = N/A)
	Fans      map[string]float64 `json:"fans"`  // fans (may be empty = N/A)
	NVMeTempC *float64           `json:"nvme_temp_c"`
	VLLM      *VLLM              `json:"vllm,omitempty"`
}

// ---- raw collected values (before CPU/mem derivation) ----

type cpuTicks struct{ total, idle float64 }

type rawMetrics struct {
	gpus       []GPU
	zones      []tagVal
	temps      map[string]float64
	powers     map[string]float64
	fans       map[string]float64
	memTotalKB float64
	memAvailKB float64
	cpu        cpuTicks
	cpuClk     *float64
	nvme       *float64
}

type tagVal struct {
	label string
	value float64
}

func f(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

// fOpt parses an optional numeric. Unavailable values (nvidia-smi emits
// "[N/A]" / "Not Supported" for unsupported query fields) and non-numeric
// input map to nil so the JSON payload reports them as unavailable (null)
// rather than a misleading 0.
func fOpt(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "NA" || s == "[N/A]" || s == "Not Supported" || s == "NotSupported" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &v
}

// ---- collection runners ----

// Collector derives CPU pct from successive raw tick samples (needs state).
type Collector struct {
	prevCPU map[string]cpuTicks
}

func NewCollector() *Collector { return &Collector{prevCPU: map[string]cpuTicks{}} }

// LocalRunner runs the embedded script as a local subprocess (head node).
type LocalRunner struct{}

func (LocalRunner) Run(ctx context.Context) (rawMetrics, error) {
	cmd := exec.CommandContext(ctx, "bash", "-s")
	cmd.Stdin = strings.NewReader(collectScript)
	out, err := cmd.Output()
	if err != nil {
		return rawMetrics{}, err
	}
	return parseCollectOutput(string(out)), nil
}

// Finalize turns raw samples into a populated NodeMetrics payload.
func (c *Collector) Finalize(nodeID, source string, raw rawMetrics) NodeMetrics {
	ts := float64(nowMS()) / 1000.0
	m := NodeMetrics{
		NodeID:    nodeID,
		TS:        ts,
		Up:        true,
		Source:    source,
		GPU:       raw.gpus,
		Zones:     map[string]float64{},
		Power:     raw.powers,
		Temps:     raw.temps,
		Fans:      raw.fans,
		CPUClkMHz: raw.cpuClk,
		NVMeTempC: raw.nvme,
	}

	for _, z := range raw.zones {
		m.Zones[z.label] = z.value
	}
	if len(raw.zones) > 0 {
		// SoC/CPU package temp = max thermal zone reading.
		max := raw.zones[0].value
		for _, z := range raw.zones[1:] {
			if z.value > max {
				max = z.value
			}
		}
		m.SocTempC = &max
	}

	if raw.memTotalKB > 0 {
		m.RAM = RAM{
			TotalMB: raw.memTotalKB / 1024,
			UsedMB:  (raw.memTotalKB - raw.memAvailKB) / 1024,
		}
		if raw.memTotalKB > 0 {
			m.RAM.Pct = (raw.memTotalKB - raw.memAvailKB) / raw.memTotalKB * 100
		}
	}

	// CPU utilisation from tick deltas.
	prev, had := c.prevCPU[nodeID]
	cur := raw.cpu
	c.prevCPU[nodeID] = cur
	if had && cur.total > prev.total {
		total := cur.total - prev.total
		idle := cur.idle - prev.idle
		if total > 0 {
			m.CPUPct = (total - idle) / total * 100
			if m.CPUPct < 0 {
				m.CPUPct = 0
			}
			if m.CPUPct > 100 {
				m.CPUPct = 100
			}
		}
	}

	return m
}

// ---- parser ----

func parseCollectOutput(out string) rawMetrics {
	r := rawMetrics{
		temps:  map[string]float64{},
		powers: map[string]float64{},
		fans:   map[string]float64{},
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		body := line
		var kind string
		if i := strings.IndexByte(line, '|'); i >= 0 {
			kind, body = line[:i], line[i+1:]
		} else {
			continue
		}
		parts := strings.Split(body, "|")
		switch kind {
		case "GPU":
			fld := strings.Split(parts[0], ",")
			if len(fld) < 11 {
				continue
			}
			r.gpus = append(r.gpus, GPU{
				Idx:        int(f(fld[0])),
				UtilPct:    f(fld[1]),
				MemPct:     fOpt(fld[2]),
				MemTotalMB: fOpt(fld[3]),
				MemUsedMB:  fOpt(fld[4]),
				PowerW:     f(fld[5]),
				TempC:      f(fld[6]),
				MemTempC:   fOpt(fld[7]),
				ClkGFXMHz:  f(fld[8]),
				ClkSMMHz:   f(fld[9]),
				ClkMemMHz:  fOpt(fld[10]),
				Name:       fld[11],
			})
		case "ZONE":
			if len(parts) >= 2 {
				r.zones = append(r.zones, tagVal{label: parts[0], value: f(parts[1])})
			}
		case "TEMP":
			if len(parts) >= 2 {
				r.temps[parts[0]] = f(parts[1])
			}
		case "POWER":
			if len(parts) >= 2 {
				r.powers[parts[0]] = f(parts[1])
			}
		case "FAN":
			if len(parts) >= 2 {
				r.fans[parts[0]] = f(parts[1])
			}
		case "MEM":
			if len(parts) >= 2 {
				r.memTotalKB = f(parts[0])
				r.memAvailKB = f(parts[1])
			}
		case "CPU":
			if len(parts) >= 8 {
				sum := 0.0
				idleIdx := -1
				perTick := []float64{f(parts[0]), f(parts[1]), f(parts[2]), f(parts[3]), f(parts[4]), f(parts[5]), f(parts[6]), f(parts[7])}
				for i, v := range perTick {
					sum += v
					if i == 3 { // idle
						idleIdx = i
					}
				}
				r.cpu.total = sum
				if idleIdx >= 0 {
					r.cpu.idle = perTick[idleIdx]
				}
			}
		case "CPUCLK":
			if len(parts) >= 1 && parts[0] != "" {
				v := f(parts[0])
				r.cpuClk = &v
			}
		case "NVME":
			if len(parts) >= 1 && parts[0] != "" {
				v := f(parts[0])
				r.nvme = &v
			}
		}
	}
	return r
}
