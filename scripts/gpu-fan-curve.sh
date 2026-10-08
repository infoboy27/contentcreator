#!/bin/bash
# Curva de ventiladores agresiva para la RX 6700 XT (amdgpu), guiada por la temperatura junction.
# - Por debajo de 55 °C devuelve el control al firmware (modo automático, ventiladores parados en reposo).
# - Desde 65 °C toma el control manual: 65 °C→45 %, 80 °C→70 %, 90 °C→90 %, 95 °C o más→100 %.
# - Sube de inmediato y baja despacio (2 % cada 2 s) para que no oscile.
# - Si el script termina o falla por cualquier motivo, devuelve el modo automático.
set -u

card_hwmon() {
  for dir in /sys/class/drm/card*/device/hwmon/hwmon*; do
    [ "$(cat "$dir/name" 2>/dev/null)" = amdgpu ] && [ -w "$dir/pwm1" ] && { echo "$dir"; return 0; }
  done
  return 1
}

H=$(card_hwmon) || { echo "No encontre una GPU amdgpu con control de ventiladores" >&2; exit 1; }
PWM_MAX=$(cat "$H/pwm1_max")

restore_auto() { echo 2 > "$H/pwm1_enable" 2>/dev/null; }
trap restore_auto EXIT
trap 'exit 0' INT TERM

# Puntos de la curva: temperatura junction (°C) y porcentaje del ventilador.
CURVE_T=(65 80 90 95)
CURVE_P=(45 70 90 100)
MANUAL_ON=65
MANUAL_OFF=55

target_percent() {
  local t=$1 i
  if [ "$t" -le "${CURVE_T[0]}" ]; then echo "${CURVE_P[0]}"; return; fi
  for ((i = 1; i < ${#CURVE_T[@]}; i++)); do
    if [ "$t" -le "${CURVE_T[i]}" ]; then
      local t0=${CURVE_T[i-1]} t1=${CURVE_T[i]} p0=${CURVE_P[i-1]} p1=${CURVE_P[i]}
      echo $(( p0 + (p1 - p0) * (t - t0) / (t1 - t0) ))
      return
    fi
  done
  echo "${CURVE_P[-1]}"
}

manual=0
current=0
last_log=0
while true; do
  raw=$(cat "$H/temp2_input" 2>/dev/null) || { echo "No pude leer la temperatura; vuelvo a automatico" >&2; exit 1; }
  temp=$(( raw / 1000 ))

  if [ "$manual" -eq 0 ] && [ "$temp" -ge "$MANUAL_ON" ]; then
    echo 1 > "$H/pwm1_enable" && manual=1
    current=$(( $(cat "$H/pwm1") * 100 / PWM_MAX ))
    echo "junction ${temp} °C: control manual activado"
  elif [ "$manual" -eq 1 ] && [ "$temp" -lt "$MANUAL_OFF" ]; then
    restore_auto
    manual=0
    echo "junction ${temp} °C: devuelvo el control al firmware"
  fi

  if [ "$manual" -eq 1 ]; then
    want=$(target_percent "$temp")
    if [ "$want" -gt "$current" ]; then current=$want
    elif [ "$want" -lt "$current" ]; then current=$(( current - 2 < want ? want : current - 2 )); fi
    echo $(( current * PWM_MAX / 100 )) > "$H/pwm1"
    now=$(date +%s)
    if [ $(( now - last_log )) -ge 60 ]; then
      echo "junction ${temp} °C, ventilador ${current} % ($(cat "$H/fan1_input") rpm), $(( $(cat "$H/power1_average") / 1000000 )) W"
      last_log=$now
    fi
  fi
  sleep 2
done
