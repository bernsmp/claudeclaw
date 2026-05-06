#!/bin/bash
# Gmail Pre-Scan for Morning Brief & EOD Recap
# Runs before brief/recap, saves results to /tmp/butters-gmail-scan.txt
# The brief/recap agent reads this file — can't skip what's already written.

HOURS="${1:-12}"  # default 12h for morning, pass 24 for EOD
OUTPUT="/tmp/butters-gmail-scan.txt"

echo "=== GMAIL CLIENT SCAN — $(date) ===" > "$OUTPUT"
echo "Window: newer_than:${HOURS}h" >> "$OUTPUT"
echo "" >> "$OUTPUT"

# Client matching patterns (grep -i patterns)
# Each line: pattern|client_label
PATTERNS="illuminatedagency.com|DJ & Katelyn / Illuminated
edensview.coach|David Limiero
chatzifot@gmail.com|Fotis Chatzinicolaou
trackablemed.com|Zed / TrackableMed
vptfinancial.com|Nick & Tim / VPT Financial
abraham.com|Jay Abraham Group
iempact.com|Michael Simmons
mjmventures.ai|Mike David
mikedavidamg@gmail.com|Mike David
lodestoneglobal.com|Will Hughes
bonnielala@gmail.com|Bonnie / Jay Newsletter
fourgenerationsoneroof.com|Jessica Bruno
leahostewart@gmail.com|Leah / Mike David
zed williamson|Zed / TrackableMed
erik trattler|Zed / TrackableMed
dj soults|Illuminated
katelyn soults|Illuminated
kent mcdonald|Illuminated
nick reiland|VPT Financial
tim kuntz|VPT Financial
mike david|Mike David
leah stewart|Mike David
jessica bruno|Jessica Bruno
mark wallace|Mark Wallace
michael hyatt|Michael Hyatt
david limiero|David Limiero
fotis|Fotis Chatzinicolaou
jay abraham|Jay Abraham
michelle abraham|Jay Abraham
luke mills|Genesis
stefan georgi|CA Labs
ryan hutchinson|Smarter Living
will hughes|Will Hughes
anand rap|Anand Rap
camille ulmer|Camille Ulmer
max voorhees|Max Voorhees
suzie kane|Suzie Kane
bonnie johnson|Jay Newsletter
laura sellers|Jay Newsletter
michael simmons|Blockbuster
carolina morales|Will Tennebaum EA
will tennebaum|Will Tennebaum
dan koe|Dan Koe
laurie chen|Laurie Chen
carla zwaan|Jay / TXL
brian kurtz|Jay / TXL
paypal.*money|PayPal Payment
payment received|PayPal Payment
you've got money|PayPal Payment
elena.*pissoni|Elena (prospect)
elenapezzo|Elena (prospect)"

# Scan both accounts
for ACCOUNT in "bernsmp@gmail.com" "max@maxpbernstein.com"; do
  echo "--- $ACCOUNT ---" >> "$OUTPUT"

  RESULTS=$(gog gmail search "newer_than:${HOURS}h" -a "$ACCOUNT" --plain 2>/dev/null)

  if [ -z "$RESULTS" ]; then
    echo "No emails in window." >> "$OUTPUT"
    echo "" >> "$OUTPUT"
    continue
  fi

  MATCHED=0

  while IFS= read -r line; do
    # Skip header and pagination lines
    [[ "$line" == "ID"* ]] && continue
    [[ "$line" == "#"* ]] && continue
    [[ -z "$line" ]] && continue

    MATCH=""

    while IFS='|' read -r pattern label; do
      [ -z "$pattern" ] && continue
      if echo "$line" | grep -qi "$pattern"; then
        MATCH="$label"
        break
      fi
    done <<< "$PATTERNS"

    if [ -n "$MATCH" ]; then
      echo "🔔 [$MATCH] $line" >> "$OUTPUT"
      MATCHED=$((MATCHED + 1))
    fi
  done <<< "$RESULTS"

  if [ $MATCHED -eq 0 ]; then
    echo "No client emails found." >> "$OUTPUT"
  else
    echo "" >> "$OUTPUT"
    echo "Total client matches: $MATCHED" >> "$OUTPUT"
  fi
  echo "" >> "$OUTPUT"
done

echo "=== SCAN COMPLETE ===" >> "$OUTPUT"
