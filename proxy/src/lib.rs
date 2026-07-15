//! CORS proxy for the Evernote PWA: forwards POSTs to the Evernote API
//! unchanged (Thrift calls and /res/ resource downloads). CORS itself
//! (preflight + response headers) is handled by the Lambda function URL
//! configuration in infra/terraform, so the code here is a plain
//! path-allowlisted forwarder.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

pub const UPSTREAM: &str = "https://www.evernote.com";
pub const DEFAULT_CONTENT_TYPE: &str = "application/x-thrift";

pub struct Forwarded {
	pub status: u16,
	pub content_type: String,
	pub body: Vec<u8>,
}

/// Only the two EDAM path families the app uses may pass through.
pub fn allowed_path(path: &str) -> bool {
	path.starts_with("/edam/") || path.starts_with("/shard/")
}

/// Method, path, request content type and raw body from a function URL (v2) event.
pub fn parse_event(event: &Value) -> (String, String, String, Vec<u8>) {
	let method = event["requestContext"]["http"]["method"]
		.as_str()
		.unwrap_or_default()
		.to_string();
	let path = event["rawPath"].as_str().unwrap_or_default().to_string();
	let content_type = event["headers"]["content-type"]
		.as_str()
		.unwrap_or(DEFAULT_CONTENT_TYPE)
		.to_string();
	let body = match event["body"].as_str() {
		Some(text) if event["isBase64Encoded"].as_bool() == Some(true) => {
			BASE64.decode(text).unwrap_or_default()
		}
		Some(text) => text.as_bytes().to_vec(),
		None => Vec::new(),
	};
	(method, path, content_type, body)
}

fn text_response(status: u16, message: &str) -> Value {
	json!({
		"statusCode": status,
		"headers": { "Content-Type": "text/plain" },
		"body": message,
		"isBase64Encoded": false,
	})
}

fn proxied_response(upstream: &Forwarded) -> Value {
	json!({
		"statusCode": upstream.status,
		"headers": { "Content-Type": upstream.content_type },
		"body": BASE64.encode(&upstream.body),
		"isBase64Encoded": true,
	})
}

/// Full request handling; the upstream call is injected so tests need no network.
pub fn handle<F>(event: &Value, forward: F) -> Value
where
	F: Fn(&str, &str, &[u8]) -> Result<Forwarded, String>,
{
	let (method, path, content_type, body) = parse_event(event);
	if !allowed_path(&path) {
		return text_response(404, "Not found");
	}
	if method != "POST" {
		return text_response(405, "Only POST");
	}
	match forward(&format!("{UPSTREAM}{path}"), &content_type, &body) {
		Ok(upstream) => proxied_response(&upstream),
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

	fn thrift(status: u16, body: &[u8]) -> Forwarded {
		Forwarded {
			status,
			content_type: DEFAULT_CONTENT_TYPE.to_string(),
			body: body.to_vec(),
		}
	}

	#[test]
	fn rejects_paths_outside_the_edam_api() {
		for path in ["/", "/admin", "/edam", "/shardx/s1"] {
			let out = handle(&event("POST", path, None, false), |_, _, _| unreachable!());
			assert_eq!(out["statusCode"], 404, "path {path}");
		}
	}

	#[test]
	fn rejects_non_post_methods() {
		let out = handle(
			&event("GET", "/edam/user", None, false),
			|_, _, _| unreachable!(),
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
			|url, content_type, body| {
				assert_eq!(url, "https://www.evernote.com/shard/s1/notestore");
				assert_eq!(content_type, DEFAULT_CONTENT_TYPE);
				assert_eq!(body, b"thrift-in");
				Ok(thrift(200, b"thrift-out"))
			},
		);
		assert_eq!(out["statusCode"], 200);
		assert_eq!(out["isBase64Encoded"], true);
		assert_eq!(out["body"], BASE64.encode(b"thrift-out"));
		assert_eq!(out["headers"]["Content-Type"], "application/x-thrift");
	}

	#[test]
	fn passes_request_and_response_content_types_through() {
		let mut ev = event("POST", "/shard/s1/res/abc", Some("auth=tok"), false);
		ev["headers"] = json!({ "content-type": "application/x-www-form-urlencoded" });
		let out = handle(&ev, |url, content_type, body| {
			assert_eq!(url, "https://www.evernote.com/shard/s1/res/abc");
			assert_eq!(content_type, "application/x-www-form-urlencoded");
			assert_eq!(body, b"auth=tok");
			Ok(Forwarded {
				status: 200,
				content_type: "image/png".to_string(),
				body: vec![137, 80, 78, 71],
			})
		});
		assert_eq!(out["statusCode"], 200);
		assert_eq!(out["headers"]["Content-Type"], "image/png");
	}

	#[test]
	fn passes_upstream_status_through() {
		let out = handle(
			&event("POST", "/edam/user", Some("plain"), false),
			|_, _, body| {
				assert_eq!(body, b"plain");
				Ok(thrift(503, b""))
			},
		);
		assert_eq!(out["statusCode"], 503);
	}

	#[test]
	fn maps_forward_errors_to_502() {
		let out = handle(&event("POST", "/edam/user", None, false), |_, _, _| {
			Err("connect timeout".to_string())
		});
		assert_eq!(out["statusCode"], 502);
		assert_eq!(out["body"], "connect timeout");
	}
}
