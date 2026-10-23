#!/bin/bash
# Play Loop: auto.sh [id] plays this match to END. Default = the Node loop (tools/v7node/loop.js: reads state/lessons.json,
# prints RESULT, then starts tools/improve.js). GBW_PLAY_LOOP=bash runs the old bash rule loop below instead.
D=$(cd "$(dirname "$0")" && pwd)
[ "${GBW_PLAY_LOOP:-node}" != bash ] && [ -f "$D/tools/v7node/loop.js" ] && exec bash "$D/tools/v7node/auto-node.sh" "$@"
# bash rule loop (fallback)
cd "$D"; id=${1:-0}; zone=4; fd=0; fg=0; fdp=0; fin=0; first=1; rm -f /tmp/medic_want; : > /tmp/acked; mbank=0; prevab=; ghs=
o=$(bash tools/warrior-helpers/gs.sh "$id")
while true; do
  l=$(echo "$o"|tail -1); echo "$l"; nid=$(echo "$l"|cut -f1)
  case "$nid" in ''|*[!0-9]*) echo "loop: bad report, retrying: $l"; sleep 2; o=$(bash tools/warrior-helpers/gs.sh "$id"); continue;; esac; id=$nid
  echo "$l"|grep -q "	END	" && exit
  ord=()
  bt=0; echo "$l"|grep -qE '\| base-threat' && bt=1   # medic-want never holds reinforcements while the base is threatened (Oct 20)
  act=$(echo "$l"|grep -oP 'act \K[0-9]'); act=${act:-6}; res=$(echo "$l"|grep -oP 'res \K\S+')
  tw=0; echo "$l"|grep -q ' gun G' && tw=1  # towers on (v6 reports): Oct 15 tower/HP rules below only run with this
  if [ "$act" -lt 6 ] && [ "$res" != none ]; then ord+=("DEPLOY ALL")
  elif [ "$act" -lt 6 ] && ! { [ -s /tmp/medic_want ] && [ $bt = 0 ]; } && echo "$l"|grep -qE 'can buy: [^|]*[TR][0-9]+x'; then u=$(echo "$l"|grep -oP 'can buy: [^|]*?\K[TR](?=[0-9]+x)'|head -1); nt=$(( $(echo "$l"|grep -oP '\| f \K[^|]+'|grep -oE '\bT[0-9]+@'|wc -l) + $(echo "$res"|grep -oP '([0-9]+)(?=T)'|awk '{s+=$1}END{print s+0}') )); [ "$u" = T ] && { [ "$tw" = 1 ] || [ "$nt" -ge 2 ]; } && u=R  # 2-Breaker cap: rifles instead; with towers no Breaker re-buys at all (Oct 15 sweeps: 34% -> 54% wins)
    fr=$((6-act)); pu=$(echo "$l"|grep -oP "can buy: [^|]*?\b$u\K[0-9]+(?=x)"|head -1); bk1=$(echo "$l"|grep -oP ' b\K[0-9]+(?= h)')
    if [ "$tw" = 1 ] && [ "$fr" -ge 2 ] && [ $((${bk1:-0}-${pu:-999})) -ge 40 ]; then ord+=("BUY $u" "BUY R" "DEPLOY ALL"); else ord+=("BUY $u" "DEPLOY $u"); fi  # towers: a second free slot and a Rifle's money left: buy both, deploy both
  elif [ "$act" -ge 6 ] && ! { [ -s /tmp/medic_want ] && [ $bt = 0 ]; }; then bk0=$(echo "$l"|grep -oP ' b\K[0-9]+(?= h)'); rn0=$(echo "$res"|grep -oP '[0-9]+'|awk '{s+=$1}END{print s+0}'); [ "$res" = none ] && rn0=0
    # Green-spend fix (Oct 14): field full and bank >= 200, keep up to two reinforcements waiting in reserve
    if [ "${bk0:-0}" -ge 200 ] && [ "${rn0:-0}" -lt 2 ]; then nt=$(( $(echo "$l"|grep -oP '\| f \K[^|]+'|grep -oE '\bT[0-9]+@'|wc -l) + $(echo "$res"|grep -oP '([0-9]+)(?=T)'|awk '{s+=$1}END{print s+0}') )); nm=$(echo "$l"|grep -oP '\| f \K[^|]+'|grep -oE '\bM[0-9]+@'|wc -l); if [ "$nt" -lt 2 ] && [ "$tw" != 1 ]; then ord+=("BUY T"); elif [ "$nm" -lt 1 ]; then ord+=("BUY M"); else ord+=("BUY R"); fi; fi
  fi
  # Grouped reinforcements (Oct 15 tower matches T286/T210; towers on): behind or under 4 on the field, never buy one rifle and send it in alone. Bank until 2 units can be
  # fielded together (reserve + affordable Rifles), then BUY twice and DEPLOY ALL. A lone unit waits at most 12 s of sim time (reports come every 4 s). BANK pauses a running AUTOBUY while waiting.
  if [ "$tw" = 1 ] && [ $fin = 0 ] && [ "$act" -lt 6 ] && ! { [ -s /tmp/medic_want ] && [ $bt = 0 ]; } && { echo "$l"|grep -qE "\| (behind|base-threat)" || [ "$(echo "$l"|grep -oP '\| f \K[^|]+'|wc -w)" -lt 4 ]; }; then
    tg=$(echo "$l"|grep -oP " T\K[0-9]+"|head -1); tg=${tg:-0}; rf=$(echo "$l"|grep -oP 'res \K.*?(?= b[0-9])'|head -1); gr=$(echo "$rf"|grep -oP '[0-9]+'|awk '{s+=$1}END{print s+0}'); [ "$rf" = none ] && gr=0
    cR=$(echo "$l"|grep -oP 'can buy: [^|]*?\bR[0-9]+x\K[0-9]+'|head -1); cR=${cR:-0}; gfr=$((6-act)); need=2; [ $gfr -lt 2 ] && need=1; have=$((gr+cR)); ord=()
    if [ $have -ge $need ] || { [ $have -ge 1 ] && [ -n "$ghs" ] && [ $((tg-ghs)) -ge 12 ]; }; then
      nb=$((need-gr)); [ $nb -gt $cR ] && nb=$cR; [ $nb -lt 0 ] && nb=0; for ((gi=0;gi<nb;gi++)); do ord+=("BUY R"); done; [ $((gr+nb)) -ge 1 ] && ord+=("DEPLOY ALL"); ghs=; echo "  GROUP release T$tg: res $gr + buy $nb"
    else
      if [ $have -ge 1 ]; then [ -z "$ghs" ] && ghs=$tg; else ghs=; fi
      abt=$(echo "$l"|grep -oP '\bauto [A-Z]+( r[0-9]+)?( bank| max| cap)?'|head -1); [ -n "$abt" ] && [ "$abt" != "auto OFF" ] && ! echo "$abt"|grep -qE 'bank|max|cap' && ord+=("BANK"); echo "  GROUP hold T$tg: have $have of $need"
    fi
  else ghs=; fi
  mfa=$((6-act)); printf '%s\n' "${ord[@]}" | grep -qx 'DEPLOY ALL' && mfa=$((mfa - $(echo "$l"|grep -oP 'res \K.*?(?= b[0-9])'|grep -oP '\b[0-9]+(?=[A-Z]\b)'|awk '{s+=$1}END{print s+0}')))  # mortar-keep slot check (Oct 20): no BUY O/DEPLOY O once a DEPLOY ALL in this post fills the field
  no=$(echo "$l"|grep -oE "O[0-9]+@z" | wc -l); if [ "$act" -lt 6 ] && [ "$no" -lt 2 ] && [ "$mfa" -ge 1 ] && echo "$l"|grep -qE "\| f [^|]*T[0-9]+@z" && echo "$l"|grep -qE "can buy: [^|]*\bO[0-9]+x"; then n2=(); for x in "${ord[@]}"; do case "$x" in "BUY T"|"BUY R"|"DEPLOY T"|"DEPLOY R") ;; *) n2+=("$x");; esac; done; ord=("${n2[@]}" "BUY O" "DEPLOY O"); fi  # mortar-keep (Oct 14 fix): only with a Breaker on the field to screen the tubes; drops the T/R buy+deploy pair cleanly
  if [ $fd = 0 ] && echo "$l"|grep -qE 'bought [0-9]D|D@z'; then ord+=("FOCUS D"); fd=1; fi
  ef=$(echo "$l"|grep -oP '\| E [0-9]+ f \K[^|]+'|sed 's/ *$//')
  mine=$(echo "$l"|grep -oP '\| f \K[^|]+'|wc -w)
  rn=$(echo "$res"|grep -oP '[0-9]+'|awk '{s+=$1}END{print s+0}'); rn=${rn:-0}
  en=$(echo "$ef"|tr ' ' '\n'|grep -v none|sed -E 's/^([0-9]*)[A-Z].*/\1/'|sed 's/^$/1/'|awk '{s+=$1}END{print s+0}'); en=${en:-0}
  ours=$((mine+rn))
  # Tower / Team HP facts (Oct 15; only with towers on). lead = our Team HP minus Ember's; ahead follows the 360 s tie-break order: HP, towers taken, zones held.
  t=$(echo "$l"|grep -oP " T\K[0-9]+"|head -1); hold=0; pushm=0; lead=0; ahead=1; foelow=9
  if [ "$tw" = 1 ]; then
    myhp=$(echo "$l"|grep -oP ' hp\K[0-9]+'|head -1); ehp=$(echo "$l"|grep -oP '\| E \K[0-9]+'|head -1); lead=$(( ${myhp:-100} - ${ehp:-100} ))
    egn=$(echo "$l"|grep -oP ' gun G\S+ E\K\S+'); ogn=$(echo "$l"|grep -oP ' gun G\K\S+'); odp=$(echo "$l"|grep -oP ' dep G\K\S+'); edp=$(echo "$l"|grep -oP ' dep G\S+ E\K\S+')
    ohs=$(echo "$l"|grep -oP 'hosp G\K-?[0-9]+'|head -1); ehs=$(echo "$l"|grep -oP 'hosp G\S+ E\K-?[0-9]+'|head -1)
    pts=0; epts=0; [ "$egn" = - ] && pts=$((pts+2)); [ "$edp" = - ] && pts=$((pts+3)); case "$ehs" in -*) pts=$((pts+1));; esac
    [ "$ogn" = - ] && epts=$((epts+2)); [ "$odp" = - ] && epts=$((epts+3)); case "$ohs" in -*) epts=$((epts+1));; esac
    zg=$(echo "$l"|grep -oP '\| z \K[0-9]+'|head -1); ze=$(echo "$l"|grep -oP '\| z [0-9]+/\K[0-9]+'|head -1)
    ahead=0; if [ "$lead" -gt 0 ] || { [ "$lead" -eq 0 ] && { [ $pts -gt $epts ] || { [ $pts -eq $epts ] && [ "${zg:-0}" -gt "${ze:-0}" ]; }; }; }; then ahead=1; fi
    # lowest zone with an enemy ground unit (Scouts and Medics do not count)
    foelow=$(echo "$ef"|tr ' ' '\n'|grep -E '^[0-9]*[A-Z]@z[0-9]'|grep -vE '^[0-9]*[SM]@'|grep -oP '@z\K[0-9]'|sort -n|head -1); foelow=${foelow:-9}
    [ "${t:-0}" -ge 200 ] && [ "$lead" -ge 1 ] && hold=1          # ahead on Team HP late: no more pushing, keep the lead
    [ "${t:-0}" -ge 240 ] && [ $ahead = 0 ] && pushm=1            # behind or level on the tie-break late: go and take their gun tower
  fi
  if [ $fin = 0 ] && [ "$mine" -ge 3 ] && [ "${t:-0}" -ge 30 ] && { [ "$ef" = none ] || echo "$l"|grep -qE '[A-Z][0-9]+@z6' && [ $((mine-en)) -ge 3 ]; }; then ord=("FOCUS TURRET" "MOVE_ALL z8" "${ord[@]}"); fin=1
  elif [ $fin = 0 ] && [ -n "$ef" ] && echo "$l"|{ echo "$l"|grep -qE "\| ahead" || { echo "$l"|grep -qE "\| even" && [ "${t:-0}" -ge 60 ]; }; } && [ "${t:-0}" -ge 30 ] && [ "$mine" -ge 4 ] && [ $((mine-en)) -ge 2 ] && [ $zone -lt 6 ] && [ $hold = 0 ]; then zone=$((zone+1)); ord+=("MOVE_ALL z$zone")
  elif [ $fin = 0 ] && echo "$l"|grep -qE "\| (behind|base-threat)" && [ $zone -gt 4 ] && [ $pushm = 0 ] && true || false; then zone=$((zone-1)); ord+=("MOVE_ALL z$zone")
  elif false && [ $((en-ours)) -ge 2 ] && [ $zone -gt 4 ]; then zone=$((zone-1)); ord+=("MOVE_ALL z$zone"); fi
  # Towers (TOWERS=1 reports carry " gun G<hp> E<hp|->" and " dep G<hp> E<hp|->"; nothing here runs without them). FOCUS GUN from the z6 push stage while the
  # Ember gun tower stands, FOCUS NONE once it is down. In the final assault (fin) with our units in z8, the base turret down and the depot up: FOCUS DEPOT (drops
  # their x0.6 base shield), FOCUS NONE when it falls. Posted only when the post has a free line (3 per post), so the zone MOVE orders are never pushed out.
  eg=$(echo "$l"|grep -oP ' gun G\S+ E\K\S+'); ed=$(echo "$l"|grep -oP ' dep G\S+ E\K\S+'); et=$(echo "$l"|grep -oP ' tur G\S+ E\K\S+')
  if [ -n "$eg" ] && [ ${#ord[@]} -lt 3 ]; then
    if [ $fin = 0 ] && [ $fg = 0 ] && [ $zone -ge 6 ] && [ "$eg" != - ]; then ord+=("FOCUS GUN"); fg=1
    elif [ $fin = 0 ] && [ $fg = 1 ] && [ "$eg" = - ]; then ord+=("FOCUS NONE"); fg=2
    elif [ $fin = 1 ] && [ $fdp = 0 ] && [ -n "$ed" ] && [ "$ed" != - ] && [ "$et" = - ] && echo "$l"|grep -oP '\| f \K[^|]+'|grep -qE '@z8'; then ord+=("FOCUS DEPOT"); fdp=1
    elif [ $fdp = 1 ] && [ "$ed" = - ]; then ord+=("FOCUS NONE"); fdp=2; fi
  fi
  sc=$(echo "$ef"|grep -oP '([0-9]*)S(?=@|\b)'|sed 's/S//;s/^$/1/'|awk '{s+=$1}END{print s+0}'); sc=${sc:-0}
  if [ "${ar:-0}" = 0 ] && [ $en -ge 3 ] && [ $((sc*2)) -ge $en ]; then ord=("AUTOBUY R" "${ord[@]}"); ar=1; fi
  # reserve cap 4 (Oct 14, Ray): 4+ waiting -> pause arena AUTOBUY R, save for Breaker (<2 alive) or Mortar (<2 alive); resume below 4
  if [ "${ar:-0}" = 1 ] && [ "$rn" -ge 4 ]; then ord=("AUTOBUY OFF" "${ord[@]}"); ar=2; elif [ "${ar:-0}" = 2 ] && [ "$rn" -lt 4 ]; then ord=("AUTOBUY R" "${ord[@]}"); ar=1; fi
  if [ "$rn" -ge 4 ] && [ "$act" -ge 6 ]; then n2=(); for x in "${ord[@]}"; do [ "$x" = "BUY R" ] || n2+=("$x"); done; ord=("${n2[@]}"); ntc=$(( $(echo "$l"|grep -oP '\| f \K[^|]+'|grep -oE '\bT[0-9]+@'|wc -l) + $(echo "$res"|grep -oP '([0-9]+)(?=T)'|awk '{s+=$1}END{print s+0}') )); noc=$(( $(echo "$l"|grep -oP '\| f \K[^|]+'|grep -oE '\bO[0-9]+@'|wc -l) + $(echo "$res"|grep -oP '([0-9]+)(?=O)'|awk '{s+=$1}END{print s+0}') )); if [ "$ntc" -lt 2 ] && [ "$tw" != 1 ] && echo "$l"|grep -qE 'can buy: [^|]*\bT[0-9]+x'; then ord+=("BUY T"); elif [ "$noc" -lt 2 ] && echo "$l"|grep -qE 'can buy: [^|]*\bO[0-9]+x'; then ord+=("BUY O"); fi; fi
  if [ $fin = 0 ] && [ $zone -gt 4 ] && [ "$mine" -lt 4 ] && ! { [ $pushm = 1 ] && [ "$mine" -ge 3 ]; }; then zone=4; ord+=("MOVE_ALL z4"); fi
  fz=2; [ "$tw" = 1 ] && [ "${ogn:--}" != - ] && [ "${ogn:-0}" -gt 0 ] && fz=3  # Oct 15: fall back under our own gun tower (z3) while it stands, z2 only once it is dead
  if [ $fin = 0 ] && [ "$mine" -le 2 ] && [ $zone -gt $fz ] && echo "$l"|grep -qE "\| (behind|base-threat)"; then zone=$fz; ord+=("MOVE_ALL z$fz"); elif [ $fin = 0 ] && [ $zone -lt 4 ] && [ "$mine" -ge 4 ]; then zone=4; ord+=("MOVE_ALL z4"); fi
  # Tower / Team HP play (Oct 15; sweeps in docs/TOWERS.md). Moves go to the front of the post so the 3-line cut never drops them.
  if [ "$tw" = 1 ] && [ $fin = 0 ]; then
    hm=""
    if [ $hold = 1 ] && [ $zone -gt 4 ]; then zone=4; hm="MOVE_ALL z4"                                               # ahead on Team HP late: back to z4, hold the lead
    elif [ $pushm = 1 ] && [ "$mine" -ge 3 ] && [ $zone -lt 6 ] && [ "$foelow" -gt 3 ]; then zone=6; hm="MOVE_ALL z6"  # behind late: push to z6, FOCUS GUN follows below
    elif [ "${t:-0}" -ge 318 ] && [ $lead -lt 0 ] && [ $lead -ge -30 ] && [ -n "$edp" ] && [ "$edp" != - ] && [ "$mine" -ge 3 ] && [ "${bn:-0}" = 0 ]; then bn=1; fin=1; fdp=1; hm="FOCUS DEPOT"; ord=("MOVE_ALL z8" "${ord[@]}")  # last 40 s, behind within 30 HP: all in on their depot (-20 HP)
    fi
    if [ -n "$hm" ]; then n2=(); for x in "${ord[@]}"; do case "$x" in MOVE_ALL*) [ "$hm" = "FOCUS DEPOT" ] && n2+=("$x");; *) n2+=("$x");; esac; done; ord=("$hm" "${n2[@]}"); fi
    # assist: a structure of ours lost HP since the last report and an enemy ground unit stands in its zone: ASSIST that zone (units come, then walk back)
    cg=$(echo "$l"|grep -oP ' gun G\K[0-9]+'|head -1); ch=$(echo "$ohs"|grep -E '^[0-9]+$'); cd=$(echo "$l"|grep -oP ' dep G\K[0-9]+'|head -1)
    for sz in "gun:3:${cg:-0}:${pg:-0}" "hosp:4:${ch:-0}:${ph:-0}" "dep:1:${cd:-0}:${pd:-0}"; do IFS=: read -r sn sw sc sp <<<"$sz"; asn="asb$sw"
      if [ "$sc" -gt 0 ] && [ $(( ${t:-0} - ${!asn:--99} )) -ge 20 ] && [ "$sc" -lt "$sp" ] && [ "$mine" -ge 2 ] && [ $(( ${t:-0} - ${las:--99} )) -ge 6 ] && echo "$ef"|tr ' ' '\n'|grep -E '^[0-9]*[A-Z]@z[0-9]'|grep -vE '^[0-9]*[SM]@'|grep -q "@z$sw"; then ord=("ASSIST z$sw" "${ord[@]}"); las=${t:-0}; break; fi
    done
    pg=${cg:-0}; ph=${ch:-0}; pd=${cd:-0}
  fi
  bk=$(echo "$l"|grep -oP ' b\K[0-9]+(?= h)'); if [ -n "$RAID" ] && [ "${rd:-0}" = 0 ] && [ "${t:-0}" -ge 20 ] && [ "$act" -le 3 ] && [ "${bk:-0}" -ge 84 ]; then ord=("BUY S" "BUY S" "BUY S" "DEPLOY S S S" "MOVE S z8"); rd=1; echo "  RAID"; fi
  if [ $first = 1 ]; then if [ -n "$RAID" ]; then ord+=("MOVE R z4" "MOVE T z4"); else ord+=("MOVE_ALL z4"); fi; first=0; fi
  echo "$l"|grep -oP 'cmdr \S+ "[^"]*"' >> /tmp/cmdr.log
  while read -r cid ctx; do grep -qx "$cid" /tmp/acked 2>/dev/null && continue; echo "$cid" >> /tmp/acked; mapfile -t cm < <(/workspace/gbw-dev/cmdr-map.sh "$cid" "$ctx"); ord=("${cm[@]}" "${ord[@]}"); done < <(echo "$l"|grep -oP 'cmdr \K\S+ "[^"]*"'|sed 's/"//g')
  # pending medics: BANK pauses AUTOBUY, BUY M when affordable, prefer M on DEPLOY, resume AUTOBUY at 0
  mw=$(cat /tmp/medic_want 2>/dev/null); mw=${mw:-0}; mo=()
  ab=$(echo "$l"|grep -oP '\bauto \K[A-Z]+'|head -1); [ -n "$ab" ] && [ "$ab" != OFF ] && [ "$ab" != none ] && prevab=$ab
  if [ "$mw" -gt 0 ] && [ $bt = 1 ]; then mbank=0   # threatened: normal buys/deploys run (a BUY lifts BANK); medics resume after
  elif [ "$mw" -gt 0 ]; then
    ord=("${ord[@]/DEPLOY ALL/}"); tmp=(); for x in "${ord[@]}"; do [ -n "$x" ] && tmp+=("$x"); done; ord=("${tmp[@]}")
    if [ "$act" -lt 6 ] && echo "$res"|grep -qE '(^|[^A-Z])[0-9]*M'; then mo+=("DEPLOY M")
    elif [ "$act" -lt 6 ] && [ "$res" != none ] && [ -n "$res" ]; then mo+=("DEPLOY ALL"); fi
    if echo "$l"|grep -qE 'can buy: [^|]*\bM[0-9]'; then mo+=("BUY M"); [ "$mw" -gt 1 ] && mo+=("BANK")
    elif [ $mbank = 0 ]; then mo+=("BANK"); mbank=1; fi
  elif [ -n "${mdone:-}" ]; then mo+=("AUTOBUY ${prevab:-R}"); mdone=; ar=1; fi
  if [ ${#mo[@]} -gt 0 ]; then ak0=(); r0=(); for x in "${ord[@]}"; do [[ $x == ACK* ]] && ak0+=("$x") || { [[ $x == DEPLOY* && " ${mo[*]} " == *DEPLOY* ]] || r0+=("$x"); }; done; ord=("${ak0[@]}" "${mo[@]}" "${r0[@]}"); fi
  if [ -s /tmp/inject ]; then mapfile -t inj < /tmp/inject; : > /tmp/inject; ord=("${inj[@]}" "${ord[@]}"); fi
  [ ${#ord[@]} -gt 0 ] && echo "  >> ${ord[*]}"
  ak=(); rest=(); for x in "${ord[@]}"; do [ -z "$x" ] && continue; [[ $x == ACK* ]] && ak+=("$x") || rest+=("$x"); done
  for a in "${ak[@]}"; do node tools/warrior-seat.js orders "$a" --report "$id" >/dev/null 2>&1; done
  # deploy guard (Oct 20): never post DEPLOY with an empty reserve. Pool = reserve units + what this post buys first (a D buy is a pack of 3).
  dg_pool=$(echo "$l"|grep -oP 'res \K.*?(?= b[0-9])'|grep -oP '\b[0-9]+(?=[A-Z]\b)'|awk '{s+=$1}END{print s+0}')
  dg=(); for x in "${rest[@]:0:3}"; do case "$x" in "BUY D") dg_pool=$((dg_pool+3));; BUY\ [A-Z]) dg_pool=$((dg_pool+1));; DEPLOY*) if [ "$dg_pool" -le 0 ]; then echo "  GUARD: dropped $x (reserve empty)"; continue; fi; [ "$x" = "DEPLOY ALL" ] && dg_pool=0 || dg_pool=$((dg_pool-$(echo "${x#DEPLOY }"|wc -w)));; esac; dg+=("$x"); done; rest=("${dg[@]}")
  o=$(bash tools/warrior-helpers/gs.sh "$id" "${rest[@]:0:3}")
  if echo "$o"|grep -q '^ack: OK BUY M'; then mw=$(( $(cat /tmp/medic_want 2>/dev/null||echo 1) - 1 )); mbank=0; echo "  MEDIC bought T$t, $mw left"; if [ $mw -le 0 ]; then rm -f /tmp/medic_want; mdone=1; else echo $mw > /tmp/medic_want; fi; fi
  echo "$o"|grep -q '^ack: OK BANK' && mbank=1
  az=$(echo "$o"|grep -oP 'ERR ASSIST z\K[0-9]+(?=[^:]*: no enemy)'|head -1); [ -n "$az" ] && eval "asb$az=${t:-0}"  # ASSIST refused (no enemy there, e.g. a structure hit from range): no repeat to that zone for 20 s
  echo "$o"|grep -E '^ack: (ERR|OK (BUY M|DEPLOY M|BANK|AUTOBUY))'
  [ -z "$(echo "$o"|tail -1|cut -f1)" ] && { echo "loop: empty report, stopping"; echo "$o"|tail -3; exit 1; }
done
