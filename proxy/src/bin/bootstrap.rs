//! Custom Lambda runtime loop (provided.al2023): long-polls the runtime API
//! and answers function URL events with the proxied Evernote response.

use std::env;
use std::thread::sleep;
use std::time::Duration;

use evernote_cors_proxy::{DEFAULT_CONTENT_TYPE, Forwarded, handle};
use reqwest::blocking::Client;
use serde_json::Value;

const RUNTIME_API_VERSION: &str = "2018-06-01";
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_NEXT_RETRY_DELAY: Duration = Duration::from_millis(250);

fn main() {
	let api = env::var("AWS_LAMBDA_RUNTIME_API").expect("AWS_LAMBDA_RUNTIME_API is not set");
	let base = format!("http://{api}/{RUNTIME_API_VERSION}/runtime");
	// no timeout: /invocation/next blocks until the next request arrives
	let runtime = Client::builder()
		.timeout(None)
		.build()
		.expect("runtime HTTP client");
	let upstream = Client::builder()
		.timeout(UPSTREAM_TIMEOUT)
		.build()
		.expect("upstream HTTP client");

	loop {
		let next = match runtime.get(format!("{base}/invocation/next")).send() {
			Ok(resp) => resp,
			Err(error) => {
				eprintln!("fetch next invocation failed: {error}");
				sleep(FETCH_NEXT_RETRY_DELAY);
				continue;
			}
		};
		let request_id = next
			.headers()
			.get("Lambda-Runtime-Aws-Request-Id")
			.and_then(|v| v.to_str().ok())
			.unwrap_or_default()
			.to_string();
		if request_id.is_empty() {
			eprintln!("invocation without a request id; skipping");
			continue;
		}
		let event: Value = next
			.text()
			.ok()
			.and_then(|text| serde_json::from_str(&text).ok())
			.unwrap_or(Value::Null);

		let response = handle(&event, |url, content_type, body| {
			let sent = upstream
				.post(url)
				.header("Content-Type", content_type)
				.body(body.to_vec())
				.send()
				.map_err(|error| error.to_string())?;
			let status = sent.status().as_u16();
			let content_type = sent
				.headers()
				.get("Content-Type")
				.and_then(|v| v.to_str().ok())
				.unwrap_or(DEFAULT_CONTENT_TYPE)
				.to_string();
			let body = sent.bytes().map_err(|error| error.to_string())?;
			Ok(Forwarded {
				status,
				content_type,
				body: body.to_vec(),
			})
		});

		if let Err(error) = runtime
			.post(format!("{base}/invocation/{request_id}/response"))
			.header("Content-Type", "application/json")
			.body(response.to_string())
			.send()
		{
			eprintln!("posting invocation response failed: {error}");
		}
	}
}
