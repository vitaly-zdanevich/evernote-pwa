#!/usr/bin/env bash
# Tails the proxy's CloudWatch logs.
#
#   ./scripts/show-logs.sh              # last hour
#   SINCE=3d ./scripts/show-logs.sh     # last three days
#   ./scripts/show-logs.sh --follow     # live tail
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-evernote-pwa-cors-proxy}"
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
SINCE="${SINCE:-1h}"

if [[ -z "$AWS_REGION" ]]; then
	echo "AWS_REGION is required (or set a default region in AWS CLI config)." >&2
	exit 1
fi

exec aws logs tail "/aws/lambda/$PROJECT_NAME" \
	--region "$AWS_REGION" \
	--since "$SINCE" \
	--format short \
	"$@"
