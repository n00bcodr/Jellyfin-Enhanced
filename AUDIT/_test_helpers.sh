#!/bin/bash
# Helper functions for invalid-config testing on jellyfin-dev (port 8097)
# DO NOT use against production jellyfin (port 8096)

JF_URL="http://localhost:8097"
JF_USER="admin"
JF_PASS="4817"
PLUGIN_XML="/config/data/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced.xml"

get_token() {
  curl -s "${JF_URL}/Users/AuthenticateByName" \
    -H 'Content-Type: application/json' \
    -H 'X-Emby-Authorization: MediaBrowser Client="audit", Device="CLI", DeviceId="audit1", Version="1.0"' \
    -d "{\"Username\":\"${JF_USER}\",\"Pw\":\"${JF_PASS}\"}" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('AccessToken',''))"
}

probe() {
  local TOKEN=$1
  echo "  status:        $(curl -s -w '|%{http_code}' -H "X-Emby-Token: $TOKEN" "${JF_URL}/JellyfinEnhanced/jellyseerr/status" 2>/dev/null | head -c 200)"
  echo "  user-status:   $(curl -s -w '|%{http_code}' -H "X-Emby-Token: $TOKEN" "${JF_URL}/JellyfinEnhanced/jellyseerr/user-status" 2>/dev/null | head -c 200)"
  echo "  search batman: $(curl -s -w '|%{http_code}' -H "X-Emby-Token: $TOKEN" "${JF_URL}/JellyfinEnhanced/jellyseerr/search?query=batman&page=1" 2>/dev/null | head -c 200)"
  echo "  discover/movie/popular: $(curl -s -w '|%{http_code}' -H "X-Emby-Token: $TOKEN" "${JF_URL}/JellyfinEnhanced/jellyseerr/discover/movies" 2>/dev/null | head -c 150)"
}

set_config_field() {
  local FIELD=$1
  local VALUE=$2
  docker exec jellyfin-dev sh -c "sed -i 's|<${FIELD}>[^<]*</${FIELD}>|<${FIELD}>${VALUE}</${FIELD}>|' '${PLUGIN_XML}'"
  # Caches need to clear — easiest is restart, but let's see if endpoint hot-reload works
}

restore_config() {
  docker exec jellyfin-dev cp "${PLUGIN_XML}.audit-backup" "${PLUGIN_XML}"
}

restart_jf() {
  docker restart jellyfin-dev > /dev/null 2>&1
  sleep 10
}

clear_caches() {
  # Hit a cache-clear endpoint if one exists, else restart
  restart_jf
}
