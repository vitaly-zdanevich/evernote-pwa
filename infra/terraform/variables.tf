variable "aws_region" {
  description = "AWS region for deployment."
  type        = string
}

variable "project_name" {
  description = "Project name prefix."
  type        = string
  default     = "evernote-pwa-cors-proxy"
}

variable "lambda_zip_path" {
  description = "Path to the packaged Lambda ZIP file."
  type        = string
}

variable "lambda_memory_size" {
  description = "Lambda memory in MB. The proxy is I/O bound, so the minimum is enough."
  type        = number
  default     = 128

  validation {
    condition     = var.lambda_memory_size >= 128 && var.lambda_memory_size <= 10240
    error_message = "lambda_memory_size must be between 128 and 10240."
  }
}

variable "lambda_architecture" {
  description = "Lambda CPU architecture."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "lambda_architecture must be arm64 or x86_64."
  }
}

variable "allowed_origin" {
  description = "Web origin allowed by CORS to call the proxy."
  type        = string
  default     = "https://vitaly-zdanevich.github.io"
}
