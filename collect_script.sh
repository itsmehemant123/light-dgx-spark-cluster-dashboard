#!/usr/bin/env bash
# Collect per-node hardware metrics and emit newline-delimited tagged lines.
# Missing sources are simply omitted (the server marks them N/A).
#
# Line formats emitted by this script:
#   GPU|idx,util_pct,mem_pct,mem_total_mb,mem_used_mb,power_w,temp_c,mem_temp_c,clk_gfx,clk_sm,clk_mem,name
#   ZONE|<type_label>|<temp_c>              (sysfs thermal_zone -> SoC/CPU package)
#   TEMP|<hwmon_label>|<temp_c>
#   POWER|<hwmon_label>|<watts>
#   FAN|<hwmon_label>|<rpm>
#   MEM|<total_kb>|<available_kb>
#   CPU|<user>|<nice>|<system>|<idle>|<iowait>|<irq>|<softirq>|<steal>
#   NVME|<temp_c>
set -u

# --- GPU (per-die) ---
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi \
    --query-gpu=index,utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,temperature.gpu,temperature.memory,clocks.current.graphics,clocks.current.sm,clocks.current.memory,name \
    --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | sed 's/\[N\/A\]/NA/g; s/NotSupported/NA/g' | while IFS=',' read -r idx ug um memtot memused pw tg tm cg csm cm name; do
      printf 'GPU|%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$idx" "$ug" "$um" "$memtot" "$memused" "$pw" "$tg" "$tm" "$cg" "$csm" "$cm" "$name"
    done
fi

# --- Thermal zones (SoC / CPU package; not shown by nvidia-smi) ---
for z in /sys/class/thermal/thermal_zone*; do
  [ -e "$z/temp" ] || continue
  t=$(cat "$z/temp" 2>/dev/null) || continue
  ty=$(cat "$z/type" 2>/dev/null); [ -z "$ty" ] && ty=$(basename "$z")
  tc=$(awk "BEGIN{printf \"%.1f\", $t/1000}")
  printf 'ZONE|%s|%s\n' "$ty" "$tc"
done

# --- hwmon sensors (spark_hwmon driver: temps + powers + any fans) ---
for h in /sys/class/hwmon/hwmon*; do
  [ -d "$h" ] || continue
  # temps (millidegrees)
  for t in "$h"/temp*_input; do
    [ -e "$t" ] || continue
    lbl=$(cat "${t%_input}_label" 2>/dev/null); [ -z "$lbl" ] && lbl=$(basename "$t" _input)
    v=$(cat "$t" 2>/dev/null) || continue
    vc=$(awk "BEGIN{printf \"%.1f\", $v/1000}")
    printf 'TEMP|%s|%s\n' "$lbl" "$vc"
  done
  # powers (microwatts -> watts); average-friendly, instantaneous oscillates
  for p in "$h"/power*_input; do
    [ -e "$p" ] || continue
    lbl=$(cat "${p%_input}_label" 2>/dev/null); [ -z "$lbl" ] && lbl=$(basename "$p" _input)
    v=$(cat "$p" 2>/dev/null) || continue
    vw=$(awk "BEGIN{printf \"%.1f\", $v/1000000}")
    printf 'POWER|%s|%s\n' "$lbl" "$vw"
  done
  # fans
  for f in "$h"/fan*_input; do
    [ -e "$f" ] || continue
    lbl=$(cat "${f%_input}_label" 2>/dev/null); [ -z "$lbl" ] && lbl=$(basename "$f" _input)
    v=$(cat "$f" 2>/dev/null) || continue
    printf 'FAN|%s|%s\n' "$lbl" "$v"
  done
done

# --- Memory ---
if [ -e /proc/meminfo ]; then
  memtotal=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
  memavail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)
  [ -n "${memtotal:-}" ] && [ -n "${memavail:-}" ] && printf 'MEM|%s|%s\n' "$memtotal" "$memavail"
fi

# --- CPU ticks from /proc/stat ---
if [ -e /proc/stat ]; then
  first=$(head -n1 /proc/stat 2>/dev/null)
  set -- $first
  if [ "$1" = "cpu" ]; then
    # $2..$9 => user nice system idle iowait irq softirq steal
    printf 'CPU|%s|%s|%s|%s|%s|%s|%s|%s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"
  fi
fi

# --- CPU clock (best-effort; kHz -> MHz) ---
if [ -e /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq ]; then
  khz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null)
  if [ -n "$khz" ]; then
    mhz=$(awk "BEGIN{printf \"%.0f\", $khz/1000}")
    printf 'CPUCLK|%s\n' "$mhz"
  fi
fi

# --- NVMe temperature (best-effort, first device) ---
if command -v nvme >/dev/null 2>&1; then
  for d in /dev/nvme*n1; do
    [ -e "$d" ] || continue
    t=$(nvme smart-log "$d" 2>/dev/null | sed -n 's/^temperature[^0-9]*\([0-9]*\).*/\1/p' | head -1)
    [ -n "$t" ] && printf 'NVME|%s\n' "$t"
    break
  done
fi
