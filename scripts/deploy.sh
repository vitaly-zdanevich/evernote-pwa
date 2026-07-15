#!/usr/bin/env bash
# Builds the Rust CORS proxy for the native Lambda CPU (arm64 Graviton,
# target-cpu=neoverse-n1) and deploys it with Terraform.
#
#   AWS_REGION=eu-central-1 ./scripts/deploy.sh
#
# The printed function URL goes into the app: Settings -> API base URL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$ROOT_DIR/proxy"
TOOLS_DIR="$ROOT_DIR/.tools"
BUILD_ROOT="${BUILD_ROOT:-$ROOT_DIR/.build/$(id -un)}"
mkdir -p "$BUILD_ROOT"
BUILD_ROOT="$(cd "$BUILD_ROOT" && pwd)"
BUILD_DIR="$BUILD_ROOT/rust-lambda"
ZIP_PATH="$BUILD_ROOT/rust-lambda.zip"
TERRAFORM_DIR="$ROOT_DIR/infra/terraform"
BACKEND_FILE="$TERRAFORM_DIR/backend.tf"

AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
PROJECT_NAME="${PROJECT_NAME:-evernote-pwa-cors-proxy}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://vitaly-zdanevich.github.io}"
LAMBDA_MEMORY_SIZE="${LAMBDA_MEMORY_SIZE:-128}"
PACKAGE_ONLY="${PACKAGE_ONLY:-}"
TF_STATE_BUCKET="${TF_STATE_BUCKET:-}"
TF_STATE_KEY="${TF_STATE_KEY:-$PROJECT_NAME/terraform.tfstate}"
RUST_LAMBDA_ARCH="${RUST_LAMBDA_ARCH:-arm64}"

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "Missing required command: $1" >&2
		exit 1
	}
}

install_local_rustup() {
	local arch
	local rustup_arch
	local tmp_dir

	arch="$(uname -m)"
	case "$arch" in
		x86_64 | amd64)
			rustup_arch="x86_64"
			;;
		aarch64 | arm64)
			rustup_arch="aarch64"
			;;
		*)
			echo "Unsupported host architecture for automatic rustup install: $arch" >&2
			exit 1
			;;
	esac

	export RUSTUP_HOME="$TOOLS_DIR/rustup"
	export CARGO_HOME="$TOOLS_DIR/cargo"
	export PATH="$CARGO_HOME/bin:$PATH"

	if [[ -x "$CARGO_HOME/bin/rustup" ]]; then
		return
	fi

	echo "rustup not found; installing a project-local Rust toolchain into $TOOLS_DIR"
	tmp_dir="$(mktemp -d)"
	trap 'rm -rf "${tmp_dir:-}"' RETURN

	curl -fsSL \
		-o "$tmp_dir/rustup-init" \
		"https://static.rust-lang.org/rustup/dist/${rustup_arch}-unknown-linux-gnu/rustup-init"
	chmod +x "$tmp_dir/rustup-init"

	"$tmp_dir/rustup-init" \
		-y \
		--no-modify-path \
		--profile minimal \
		--default-toolchain stable \
		--target "$rust_target"
	rm -rf "$tmp_dir"
	trap - RETURN
}

ensure_rust_target() {
	if command -v rustup >/dev/null 2>&1; then
		if ! rustup target list --installed | grep -qx "$rust_target"; then
			echo "Rust target $rust_target not found; installing it with rustup"
			rustup target add "$rust_target"
		fi
	else
		install_local_rustup
		if ! rustup target list --installed | grep -qx "$rust_target"; then
			rustup target add "$rust_target"
		fi
	fi
}

ensure_cargo_lambda() {
	export PATH="$TOOLS_DIR/bin:$PATH"

	if cargo lambda --version >/dev/null 2>&1; then
		return
	fi

	echo "cargo-lambda not found; installing it into $TOOLS_DIR"
	cargo install cargo-lambda --root "$TOOLS_DIR"
}

if [[ -z "$AWS_REGION" ]]; then
	echo "AWS_REGION is required (or set a default region in AWS CLI config)." >&2
	exit 1
fi

case "$RUST_LAMBDA_ARCH" in
	arm64)
		cargo_lambda_arch_arg="--arm64"
		rust_target="aarch64-unknown-linux-gnu"
		rustflags_env="CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS"
		default_rust_target_cpu="neoverse-n1"
		;;
	x86_64)
		cargo_lambda_arch_arg="--x86-64"
		rust_target="x86_64-unknown-linux-gnu"
		rustflags_env="CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS"
		default_rust_target_cpu="x86-64-v3"
		;;
	*)
		echo "RUST_LAMBDA_ARCH must be arm64 or x86_64." >&2
		exit 1
		;;
esac

RUST_TARGET_CPU="${RUST_TARGET_CPU:-$default_rust_target_cpu}"

require_cmd zip
require_cmd terraform
require_cmd curl

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$(dirname "$ZIP_PATH")"

ensure_rust_target
ensure_cargo_lambda

current_target_rustflags="${!rustflags_env:-}"
export "$rustflags_env=${current_target_rustflags:+$current_target_rustflags }-C target-cpu=$RUST_TARGET_CPU"

echo "Building Rust Lambda for $rust_target with target-cpu=$RUST_TARGET_CPU"
rm -rf "$RUST_DIR/target/lambda/bootstrap"
(
	cd "$RUST_DIR"
	cargo lambda build --release --bin bootstrap "$cargo_lambda_arch_arg"
)

BOOTSTRAP_PATH="$RUST_DIR/target/lambda/bootstrap/bootstrap"
if [[ ! -x "$BOOTSTRAP_PATH" ]]; then
	echo "Rust Lambda bootstrap was not built at expected path: $BOOTSTRAP_PATH" >&2
	exit 1
fi

cp "$BOOTSTRAP_PATH" "$BUILD_DIR/bootstrap"
chmod +x "$BUILD_DIR/bootstrap"
(
	cd "$BUILD_DIR"
	zip -qr "$ZIP_PATH" bootstrap
)

if [[ "$PACKAGE_ONLY" == "1" ]]; then
	echo "Package built: $ZIP_PATH"
	exit 0
fi

terraform_init_args=("-reconfigure")
if [[ -n "$TF_STATE_BUCKET" ]]; then
	printf '%s\n' \
		'terraform {' \
		'  backend "s3" {}' \
		'}' > "$BACKEND_FILE"
	terraform_init_args+=(
		"-backend-config=bucket=$TF_STATE_BUCKET"
		"-backend-config=key=$TF_STATE_KEY"
		"-backend-config=region=$AWS_REGION"
	)
else
	rm -f "$BACKEND_FILE"
fi

terraform -chdir="$TERRAFORM_DIR" init "${terraform_init_args[@]}"
terraform -chdir="$TERRAFORM_DIR" apply -auto-approve \
	-var "aws_region=$AWS_REGION" \
	-var "project_name=$PROJECT_NAME" \
	-var "lambda_zip_path=$ZIP_PATH" \
	-var "lambda_memory_size=$LAMBDA_MEMORY_SIZE" \
	-var "lambda_architecture=$RUST_LAMBDA_ARCH" \
	-var "allowed_origin=$ALLOWED_ORIGIN"

FUNCTION_URL="$(terraform -chdir="$TERRAFORM_DIR" output -raw function_url)"

echo "Deployment complete."
echo "Function URL: $FUNCTION_URL"
echo "Paste it (without the trailing slash) into the app: Settings -> API base URL."
