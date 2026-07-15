output "function_url" {
  description = "Public function URL; paste it into the app Settings as the API base URL (without the trailing slash)."
  value       = aws_lambda_function_url.proxy.function_url
}
