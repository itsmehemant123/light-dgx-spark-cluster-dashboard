package main

import (
	"context"
	"math"
	"math/rand"
	"sync/atomic"
	"time"
)

// DemoRunner synthesizes plausible per-node metrics so the full server/SSE/UI
// stack can be exercised on a machine without NVIDIA hardware or Linux sysfs.
// Enabled only when DASH_DEMO=1.
type DemoRunner struct {
	tStart time.Time
	n      int64
}

func NewDemoRunner() *DemoRunner { return &DemoRunner{tStart: time.Now()} }

func (d *DemoRunner) Run(ctx context.Context) (rawMetrics, error) {
	t := float64(time.Since(d.tStart).Seconds())
	step := atomic.AddInt64(&d.n, 1)
	breathe := math.Sin(t/7.0)*30 + 55 // 25..85 util-ish wave
	clk := 280 + breathe*4             // graphics-ish MHz wobble

	idx := int(step) % 2
	r := rawMetrics{temps: map[string]float64{}, powers: map[string]float64{}, fans: map[string]float64{}}
	r.gpus = append(r.gpus, GPU{
		Idx:       idx,
		UtilPct:   breathe,
		PowerW:    60 + breathe*0.8 + rand.Float64()*3,
		TempC:     55 + breathe*0.15,
		ClkGFXMHz: clk,
		ClkSMMHz:  clk,
		Name:      "GB10 (demo)",
	})
	cc := 2400.0
	r.cpuClk = &cc
	soc := 88 + breathe*0.12
	r.zones = append(r.zones,
		tagVal{label: "soc_thermal", value: soc},
		tagVal{label: "cpu_thermal", value: soc - 4},
	)
	r.temps["soc_pkg"] = soc
	r.temps["gpu"] = 55 + breathe*0.15
	r.powers["sys_total"] = 250 + breathe*1.2
	r.powers["soc_pkg"] = 90 + breathe*0.6
	r.powers["cpu_gpu"] = 140 + breathe*0.9
	r.powers["gpu_total"] = 120 + breathe*0.8
	r.fans["fan0"] = 1800 + breathe*8
	r.memTotalKB = 196412 * 1024
	r.memAvailKB = r.memTotalKB - (39000+(breathe-55)*150)*1024
	r.cpu = cpuTicks{total: 1000000 + float64(step)*4200, idle: 1000000 + float64(step)*3600}
	nvme := 48.0 + rand.Float64()*4
	r.nvme = &nvme
	return r, nil
}
