//! CORS proxy for the Evernote PWA: forwards Thrift POSTs to the Evernote
//! API unchanged. CORS itself (preflight + response headers) is handled by
//! the Lambda function URL configuration in infra/terraform, so the code
//! here is a plain path-allowlisted forwarder.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

pub const UPSTREAM: &str = "https://www.evernote.com";

pub struct Forwarded {
	pub status: u16,
	pub body: Vec<u8>,
}

/// Only the two EDAM path families the app uses may pass through.
pub fn allowed_path(path: &str) -> bool {
	path.starts_with("/edam/") || path.starts_with("/shard/")
}

/// Method, path and raw body from a Lambda function URL (v2) event.
pub fn parse_event(event: &Value) -> (String, String, Vec<u8>) {
	let method = event["requestContext"]["http"]["method"]
		.as_str()
		.unwrap_or_default()
		.to_string();
	let path = event["rawPath"].as_str().unwrap_or_default().to_string();
	let body = match event["body"].as_str() {
		Some(text) if event["isBase64Encoded"].as_bool() == Some(true) => {
			BASE64.decode(text).unwrap_or_default()
		}
		Some(text) => text.as_bytes().to_vec(),
		None => Vec::new(),
	};
	(method, path, body)
}

fn text_response(status: u16, message: &str) -> Value {
	json!({
		"statusCode": status,
		"headers": { "Content-Type": "text/plain" },
		"body": message,
		"isBase64Encoded": false,
	})
}

fn thrift_response(status: u16, body: &[u8]) -> Value {
	json!({
		"statusCode": status,
		"headers": { "Content-Type": "application/x-thrift" },
		"body": BASE64.encode(body),
		"isBase64Encoded": true,
	})
}

/// Full request handling; the upstream call is injected so tests need no network.
pub fn handle<F>(event: &Value, forward: F) -> Value
where
	F: Fn(&str, &[u8]) -> Result<Forwarded, String>,
{
	let (method, path, body) = parse_event(event);
	if !allowed_path(&path) {
		return text_response(404, "Not found");
	}
	if method != "POST" {
		return text_response(405, "Only POST");
	}
	match forward(&format!("{UPSTREAM}{path}"), &body) {
		Ok(upstream) => thrift_response(upstream.status, &upstream.body),
		Err(error) => text_response(502, &error),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn event(method: &str, path: &str, body: Option<&str>, b64: bool) -> Value {
		json!({
			"rawPath": path,
			"requestContext": { "http": { "method": method } },
			"body": body,
			"isBase64Encoded": b64,
		})
	}

	#[test]
	fn rejects_paths_outside_the_edam_api() {
		for path in ["/", "/admin", "/edam", "/shardx/s1"] {
			let out = handle(&event("POST", path, None, false), |_, _| unreachable!());
			assert_eq!(out["statusCode"], 404, "path {path}");
		}
	}

	#[test]
	fn rejects_non_post_methods() {
		let out = handle(
			&event("GET", "/edam/user", None, false),
			|_, _| unreachable!(),
		);
		assert_eq!(out["statusCode"], 405);
	}

	#[test]
	fn forwards_base64_bodies_and_wraps_the_reply() {
		let out = handle(
			&event(
				"POST",
				"/shard/s1/notestore",
				Some(&BASE64.encode(b"thrift-in")),
				true,
			),
			|url, body| {
				assert_eq!(url, "https://www.evernote.com/shard/s1/notestore");
				assert_eq!(body, b"thrift-in");
				Ok(Forwarded {
					status: 200,
					body: b"thrift-out".to_vec(),
				})
			},
		);
		assert_eq!(out["statusCode"], 200);
		assert_eq!(out["isBase64Encoded"], true);
		assert_eq!(out["body"], BASE64.encode(b"thrift-out"));
		assert_eq!(out["headers"]["Content-Type"], "application/x-thrift");
	}

	#[test]
	fn passes_upstream_status_through() {
		let out = handle(
			&event("POST", "/edam/user", Some("plain"), false),
			|_, body| {
				assert_eq!(body, b"plain");
				Ok(Forwarded {
					status: 503,
					body: Vec::new(),
				})
			},
		);
		assert_eq!(out["statusCode"], 503);
	}

	#[test]
	fn maps_forward_errors_to_502() {
		let out = handle(&event("POST", "/edam/user", None, false), |_, _| {
			Err("connect timeout".to_string())
		});
		assert_eq!(out["statusCode"], 502);
		assert_eq!(out["body"], "connect timeout");
	}
}
