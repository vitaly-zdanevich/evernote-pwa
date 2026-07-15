#!/usr/bin/env bash
# Prints the proxy's CloudWatch logs. Works with AWS CLI v1 and v2.
#
#   ./scripts/show-logs.sh              # last hour
#   SINCE=3d ./scripts/show-logs.sh     # last three days
#   FOLLOW=1 ./scripts/show-logs.sh     # keep polling for new events
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-evernote-pwa-cors-proxy}"
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
SINCE="${SINCE:-1h}"

if [[ -z "$AWS_REGION" ]]; then
	echo "AWS_REGION is required (or set a default region in AWS CLI config)." >&2
	exit 1
fi

case "$SINCE" in
	*s) seconds="${SINCE%s}" ;;
	*m) seconds=$((${SINCE%m} * 60)) ;;
	*h) seconds=$((${SINCE%h} * 3600)) ;;
	*d) seconds=$((${SINCE%d} * 86400)) ;;
	*)
		echo "SINCE must look like 45s, 30m, 12h or 3d" >&2
		exit 2
		;;
esac

start_ms=$((($(date +%s) - seconds) * 1000))

show_since() {
	aws logs filter-log-events \
		--region "$AWS_REGION" \
		--log-group-name "/aws/lambda/$PROJECT_NAME" \
		--start-time "$1" \
		--query 'events[].message' \
		--output text
}

if [[ "${FOLLOW:-}" == "1" ]]; then
	while true; do
		now_ms=$(($(date +%s) * 1000))
		show_since "$start_ms"
		start_ms=$now_ms
		sleep 5
	done
else
	show_since "$start_ms"
fi
