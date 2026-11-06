#!/bin/bash
# Runs the main checks against the live API in about 15 seconds.
# Needs test.sh (which sets KEY and URL) in the same folder. Contains no secrets itself.
source "$(dirname "$0")/test.sh"

H=(-H "X-API-Key: $KEY" -H "Content-Type: application/json")
RUN=$RANDOM
SLOTS='{"slots":[
 {"id":"s1","provider":"Dr Ade","start":"2030-12-10T09:00:00Z","end":"2030-12-10T09:30:00Z"},
 {"id":"s2","provider":"Dr Ade","start":"2030-12-10T09:30:00Z","end":"2030-12-10T10:00:00Z"}]}'

step() { printf '\n=== %s ===\n' "$1"; }

step "Level 2: a request with no API key is rejected"
curl -s -o /dev/null -w "status %{http_code}\n" "$URL/slots"

step "Load two fresh slots"
curl -s -X POST "$URL/reset" "${H[@]}" -d "$SLOTS"; echo

step "Level 3: 10 simultaneous bookings for the same slot"
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/bookings" "${H[@]}" \
    -d "{\"slot_id\":\"s1\",\"name\":\"Person $i\",\"email\":\"p$i-$RUN@example.com\"}" &
done | sort | uniq -c

step "Level 4: same Idempotency-Key twice gives the same booking id"
for i in 1 2; do
  curl -s -X POST "$URL/bookings" "${H[@]}" -H "Idempotency-Key: demo-$RUN" \
    -d "{\"slot_id\":\"s2\",\"name\":\"Ada Obi\",\"email\":\"ada-$RUN@example.com\"}" | grep -o '"id":"[^"]*"'
done

step "Level 5: the sixth attempt in a minute is rate limited"
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "attempt $i: %{http_code}\n" -X POST "$URL/bookings" "${H[@]}" \
    -d "{\"slot_id\":\"nope\",\"name\":\"Spammer\",\"email\":\"spam-$RUN@example.com\"}"
done
curl -si -X POST "$URL/bookings" "${H[@]}" \
  -d "{\"slot_id\":\"nope\",\"name\":\"Spammer\",\"email\":\"spam-$RUN@example.com\"}" | grep -i '^retry-after'
echo