#!/usr/bin/env bash
# CLI smoke test for `paper` using mocked prices in a temp dir (never touches .paper/).
set -uo pipefail
cd "$(dirname "$0")/.."
export PAPER_DIR="$(mktemp -d)"; PRICES="$PAPER_DIR/prices.json"
export PAPER_MOCK_PRICES="$PRICES"
for k in $(env | grep -o '^PAPER_[A-Z_]*' | grep -v -e PAPER_DIR -e PAPER_MOCK_PRICES); do unset "$k"; done
px() { echo "{\"ETH\":[$1,$2]}" > "$PRICES"; }
C="node dist/cli.js paper"
fail=0; expect() { if [[ $1 -ne $2 ]]; then echo "!! expected exit $2 got $1"; fail=1; fi; }
px 2380 2381
echo "== rejected: R:R below 2 after fees"
$C open --symbol ETH --side long --entry market --stop 2340 --target 2462 --thesis "range break" --invalidation "back under 2340" --confidence 3; expect $? 2
echo "== accepted: market long"
$C open --symbol ETH --side long --entry market --stop 2300 --target 2700 --thesis "reclaim of 2350 with rising OI" --invalidation "daily close < 2300" --confidence 3; expect $? 0
$C list
echo "== price hits target -> watcher path closes it"
px 2701 2702
node --input-type=module -e "import {PaperBook,priceFn} from './dist/paper/ledger.js'; const ev=await new PaperBook().check(priceFn()); console.log(ev.map(e=>e.event+' '+e.position.id+' pnl='+e.position.pnl+' r='+e.position.r).join('\n'))"
$C stats --no-live
$C journal -n 5
echo "== reset needs --confirm"
$C reset; expect $? 1
$C reset --confirm; expect $? 0
rm -rf "$PAPER_DIR"
[[ $fail -eq 0 ]] && echo "SMOKE OK" || { echo "SMOKE FAILED"; exit 1; }
