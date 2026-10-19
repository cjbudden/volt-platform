# ============================================================================
#  IDENTITY: sign-in codes by text message (ACCESS_CONTROL.md section 12)
#
#  The API sends SMS codes with AWS SNS (SMS_PROVIDER=sns) using the task role,
#  so no SMS credentials are stored anywhere. Emailed codes use the existing
#  SMTP settings (SMTP_URL, NOTIFY_FROM), for example Amazon SES SMTP.
#
#  Before production SMS:
#    1. Move the AWS account out of the SNS SMS sandbox (Support case or the
#       SNS console, "Text messaging (SMS)"); in the sandbox only verified
#       numbers receive messages.
#    2. Australia and some other countries need a registered sender ID or an
#       origination number: set sms_sender_id or sms_origination_number.
#    3. Set a monthly spend limit (sms_monthly_spend_limit_usd below, or in
#       the console). The API also limits sends per person and per number.
# ============================================================================

variable "sms_provider" {
  type        = string
  default     = "sns"
  description = "sns = send SMS sign-in codes with AWS SNS. Empty = SMS codes unavailable (email and authenticator app still work)."
}

variable "sms_sender_id" {
  type        = string
  default     = ""
  description = "Alphanumeric sender ID shown on the text (where the destination country allows one), e.g. VOLT."
}

variable "sms_origination_number" {
  type        = string
  default     = ""
  description = "Origination number (E.164) for countries that require one."
}

variable "manage_sms_preferences" {
  type        = bool
  default     = false
  description = "Set the ACCOUNT-WIDE SNS SMS preferences (transactional type, spend limit). Off by default because they affect every SMS sender in the AWS account."
}

variable "sms_monthly_spend_limit_usd" {
  type        = number
  default     = 100
  description = "Account-wide SNS SMS monthly spend cap, used when manage_sms_preferences = true."
}

data "aws_iam_policy_document" "sms_publish" {
  statement {
    # Direct-to-number SMS publishes have no topic ARN to scope to.
    actions   = ["sns:Publish"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "control_plane_sms" {
  count  = var.sms_provider == "sns" ? 1 : 0
  name   = "sms-sign-in-codes"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.sms_publish.json
}

resource "aws_sns_sms_preferences" "this" {
  count               = var.manage_sms_preferences ? 1 : 0
  default_sms_type    = "Transactional"
  monthly_spend_limit = var.sms_monthly_spend_limit_usd
  default_sender_id   = var.sms_sender_id != "" ? var.sms_sender_id : null
}
