# ---- S3 watch folders: drops announced by the bucket (build queue 2.6) --------
# An S3 watch folder in the origin bucket is told about each new object by an
# ObjectCreated notification on an SQS queue, instead of the control plane
# listing every folder every minute. The scheduler's leader long-polls the
# queue (WATCH_S3_QUEUE_URL; volt-app/src/services/watchfolder/s3events.ts),
# fetches the named objects and takes their folders in at once. The walk stays
# as the backstop, once an hour.
#
# Only keys under var.watch_s3_prefix are announced. A notification on the
# whole bucket would put a message on the queue for every live segment the
# encoders upload. So S3 watch folders in this bucket live under that prefix
# (for example watch/agency/); a folder anywhere else is still found by the
# hourly walk. A customer's own bucket can send its notifications to this queue
# too, once its ARN is added to var.watch_s3_extra_bucket_arns.
#
# One aws_s3_bucket_notification per bucket: S3 keeps a single notification
# configuration, so any later notification on the origin bucket has to be
# added to this resource, not declared again elsewhere.

variable "watch_s3_prefix" {
  description = "Keys under this prefix in the origin bucket are announced to the S3 watch folder queue. S3 watch folders in the origin bucket go under it."
  type        = string
  default     = "watch/"
}

variable "watch_s3_extra_bucket_arns" {
  description = "Other buckets (a customer's own) allowed to send ObjectCreated notifications to the watch folder queue. Their notification is set up on their side."
  type        = list(string)
  default     = []
}

resource "aws_sqs_queue" "watch_drops_dlq" {
  name                      = "${local.name}-watch-drops-dlq"
  message_retention_seconds = 1209600 # 14 days to look at what could not be fetched
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "watch_drops" {
  name                       = "${local.name}-watch-drops"
  visibility_timeout_seconds = 900    # a fetch of a large drop can take minutes; retried after 15
  message_retention_seconds  = 345600 # 4 days: survives a long weekend's outage, the walk catches the rest
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.watch_drops_dlq.arn
    maxReceiveCount     = 5
  })
}

data "aws_iam_policy_document" "watch_drops" {
  statement {
    sid       = "BucketNotifications"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.watch_drops.arn]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = concat([aws_s3_bucket.origin.arn], var.watch_s3_extra_bucket_arns)
    }
  }
}

resource "aws_sqs_queue_policy" "watch_drops" {
  queue_url = aws_sqs_queue.watch_drops.id
  policy    = data.aws_iam_policy_document.watch_drops.json
}

resource "aws_s3_bucket_notification" "origin" {
  bucket = aws_s3_bucket.origin.id
  queue {
    id            = "watch-drops"
    queue_arn     = aws_sqs_queue.watch_drops.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = var.watch_s3_prefix
  }
  # S3 sends a test message when it checks it may write to the queue; the
  # policy has to exist first or the notification is refused.
  depends_on = [aws_sqs_queue_policy.watch_drops]
}

# The control plane (every role runs the same task role; only the scheduler's
# leader polls) receives and deletes.
data "aws_iam_policy_document" "control_plane_watch_drops" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.watch_drops.arn]
  }
}

resource "aws_iam_role_policy" "control_plane_watch_drops" {
  name   = "watch-drops"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.control_plane_watch_drops.json
}

output "watch_drops_queue_url" {
  value       = aws_sqs_queue.watch_drops.url
  description = "The S3 watch folder queue. A customer bucket listed in watch_s3_extra_bucket_arns sends its ObjectCreated notifications here."
}

output "watch_drops_dlq_url" {
  value       = aws_sqs_queue.watch_drops_dlq.url
  description = "Notifications that could not be handled after five tries."
}
