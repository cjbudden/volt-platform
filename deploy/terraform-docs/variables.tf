variable "project" {
  type    = string
  default = "volt"
}

variable "env" {
  type        = string
  description = "Environment name, e.g. staging or prod."
}

variable "region" {
  type    = string
  default = "ap-southeast-2"
}

variable "docs_domain" {
  type        = string
  description = "Host name of the docs site, e.g. docs.volt.example. Must share a parent domain with the Volt app (app.volt.example), because the sign-in cookie is set on that parent domain."
}

variable "cookie_domain" {
  type        = string
  description = "The shared parent domain for the sign-in cookie, with a leading dot, e.g. .volt.example."
  validation {
    condition     = startswith(var.cookie_domain, ".")
    error_message = "cookie_domain starts with a dot, e.g. .volt.example."
  }
}

variable "acm_certificate_arn" {
  type        = string
  description = "ACM certificate for docs_domain. CloudFront requires it to be in us-east-1."
}

variable "route53_zone_id" {
  type        = string
  default     = ""
  description = "Optional. When set, the docs_domain alias record is created in this hosted zone."
}

variable "app_url" {
  type        = string
  description = "The Volt app URL, e.g. https://app.volt.example. The sign-in page sends people there."
}

variable "price_class" {
  type    = string
  default = "PriceClass_All"
}

variable "tags" {
  type    = map(string)
  default = {}
}
