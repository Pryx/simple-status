#!/bin/bash
# Default-deny outbound firewall for the Claude Code sandbox.
# Allows: DNS, loopback, the Docker host network (editor/port forwarding),
# GitHub, the npm registry and the Anthropic endpoints Claude Code needs.
# Everything else is rejected. IPv6 is blocked entirely.
#
# Fails closed: if anything goes wrong, all outbound traffic is blocked.
# To allow more hosts, extend ALLOWED_DOMAINS and rebuild the container.
set -euo pipefail
IFS=$'\n\t'

ALLOWED_DOMAINS=(
  # npm
  "registry.npmjs.org"
  # Claude Code
  "api.anthropic.com"
  "claude.ai"
  "console.anthropic.com"
  "platform.claude.com"
  "statsig.anthropic.com"
  "statsig.com"
  "sentry.io"
)

lockdown() {
  echo "ERROR: firewall setup failed, blocking all outbound traffic" >&2
  iptables -P INPUT DROP || true
  iptables -P FORWARD DROP || true
  iptables -P OUTPUT DROP || true
  iptables -F OUTPUT || true
  iptables -A OUTPUT -o lo -j ACCEPT || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
  ip6tables -P INPUT DROP 2>/dev/null || true
  exit 1
}
trap lockdown ERR

# --- 1. Collect addresses while the network is still open --------------------

# Build into a temporary set and swap it in later, so re-running the script
# never empties the live allowlist while it still needs network access.
ipset destroy allowed-domains-new 2>/dev/null || true
ipset create allowed-domains-new hash:net

echo "Fetching GitHub IP ranges"
gh_ranges=$(curl -fsS --connect-timeout 10 https://api.github.com/meta)
echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null
while read -r cidr; do
  [[ "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]] || {
    echo "ERROR: invalid CIDR from GitHub meta: $cidr" >&2
    false
  }
  ipset add allowed-domains-new "$cidr" -exist
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | grep -v ':' | aggregate -q)

for domain in "${ALLOWED_DOMAINS[@]}"; do
  ips=$(dig +short A "$domain" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  if [ -z "$ips" ]; then
    echo "WARNING: $domain does not resolve, skipping" >&2
    continue
  fi
  echo "Allowing $domain"
  while read -r ip; do
    ipset add allowed-domains-new "$ip" -exist
  done <<< "$ips"
done

HOST_IP=$(ip route | awk '/default/ {print $3; exit}')
[ -n "$HOST_IP" ]
HOST_NETWORK="${HOST_IP%.*}.0/24"
echo "Host network: $HOST_NETWORK"

# --- 2. Apply rules ------------------------------------------------------------

ipset create allowed-domains hash:net -exist
ipset swap allowed-domains-new allowed-domains
ipset destroy allowed-domains-new

# Keep Docker's embedded DNS (127.0.0.11) NAT rules across the flush.
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X

if [ -n "$DOCKER_DNS_RULES" ]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# Block IPv6 completely (loopback only), so it cannot bypass the IPv4 allowlist.
if ip6tables -L >/dev/null 2>&1; then
  ip6tables -P INPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -P OUTPUT DROP
  ip6tables -F
  ip6tables -X
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
fi

# --- 3. Verify -----------------------------------------------------------------

echo "Verifying firewall"
if curl --connect-timeout 5 -fsS https://example.com >/dev/null 2>&1; then
  echo "ERROR: example.com is reachable" >&2
  false
fi
curl --connect-timeout 5 -fsS https://api.github.com/zen >/dev/null
echo "Firewall active"
