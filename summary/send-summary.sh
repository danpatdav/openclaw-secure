#!/usr/bin/env bash
set -euo pipefail

# Usage: send-summary.sh <storage_account_name> <vault_name> <verdict>
STORAGE_NAME="${1:?Usage: send-summary.sh <storage_account> <vault_name> <verdict>}"
VAULT_NAME="${2:?Usage: send-summary.sh <storage_account> <vault_name> <verdict>}"
VERDICT="${3:?Usage: send-summary.sh <storage_account> <vault_name> <verdict>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATE=$(date -u +"%Y-%m-%d")

echo "=== Generating post-run summary email ==="

# --- Download blobs ---

# Find latest memory blob
LATEST_MEMORY=$(az storage blob list \
  --account-name "$STORAGE_NAME" \
  --container-name agent-memory \
  --prefix "memory/" \
  --auth-mode key \
  --query "sort_by([?name != null], &properties.lastModified)[-1].name" \
  -o tsv 2>/dev/null || echo "")

if [ -n "$LATEST_MEMORY" ] && [ "$LATEST_MEMORY" != "null" ]; then
  az storage blob download \
    --account-name "$STORAGE_NAME" \
    --container-name agent-memory \
    --name "$LATEST_MEMORY" \
    --auth-mode key \
    --file /tmp/memory.json \
    --no-progress 2>/dev/null
  echo "Downloaded memory blob: $LATEST_MEMORY"
else
  echo '{}' > /tmp/memory.json
  echo "Warning: No memory blob found"
fi

# Find latest verdict blob (already downloaded by workflow, but re-download for safety)
LATEST_VERDICT=$(az storage blob list \
  --account-name "$STORAGE_NAME" \
  --container-name agent-memory \
  --prefix "verdicts/" \
  --auth-mode key \
  --query "sort_by([?name != null], &properties.lastModified)[-1].name" \
  -o tsv 2>/dev/null || echo "")

if [ -n "$LATEST_VERDICT" ] && [ "$LATEST_VERDICT" != "null" ]; then
  az storage blob download \
    --account-name "$STORAGE_NAME" \
    --container-name agent-memory \
    --name "$LATEST_VERDICT" \
    --auth-mode key \
    --file /tmp/verdict.json \
    --no-progress 2>/dev/null
  echo "Downloaded verdict blob: $LATEST_VERDICT"
else
  echo '{}' > /tmp/verdict.json
  echo "Warning: No verdict blob found"
fi

# --- Get secrets from Key Vault ---

ANTHROPIC_KEY=$(az keyvault secret show \
  --vault-name "$VAULT_NAME" \
  --name ANTHROPIC-API-KEY \
  --query value -o tsv)

ACS_CONNECTION_STRING=$(az keyvault secret show \
  --vault-name "$VAULT_NAME" \
  --name ACS-CONNECTION-STRING \
  --query value -o tsv)

EMAIL_RECIPIENT=$(az keyvault secret show \
  --vault-name "$VAULT_NAME" \
  --name EMAIL-RECIPIENT \
  --query value -o tsv)

# Parse ACS endpoint from connection string (format: endpoint=https://...;accesskey=...)
ACS_ENDPOINT=$(echo "$ACS_CONNECTION_STRING" | sed -n 's/.*endpoint=\([^;]*\).*/\1/p')
ACS_ACCESS_KEY=$(echo "$ACS_CONNECTION_STRING" | sed -n 's/.*accesskey=\([^;]*\).*/\1/p')

ACS_SENDER_DOMAIN=$(az keyvault secret show \
  --vault-name "$VAULT_NAME" \
  --name ACS-SENDER-DOMAIN \
  --query value -o tsv)

echo "Retrieved secrets from Key Vault"

# --- Read prompt template ---

PROMPT=$(cat "$SCRIPT_DIR/prompt.txt")

# --- Call Claude API ---

echo "Calling Claude API for summary generation..."

# Build the API request payload using file-based approach to avoid ARG_MAX limits
# Memory blobs can be 100KB+ which exceeds shell argument length limits
jq -n \
  --arg prompt "$PROMPT" \
  --rawfile memory /tmp/memory.json \
  --rawfile verdict /tmp/verdict.json \
  '{
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: ($prompt + "\n\n--- MEMORY DATA ---\n" + $memory + "\n\n--- VERDICT DATA ---\n" + $verdict)
      }
    ]
  }' > /tmp/claude_payload.json

CLAUDE_RESPONSE=$(curl -s -f \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d @/tmp/claude_payload.json \
  "https://api.anthropic.com/v1/messages")

SUMMARY=$(echo "$CLAUDE_RESPONSE" | jq -r '.content[0].text // "Summary generation failed — no content in response."')

echo "Summary generated ($(echo "$SUMMARY" | wc -w | tr -d ' ') words)"

# --- Send email via Azure Communication Services ---

echo "Sending email via Azure Communication Services..."

SUBJECT="DanielsClaw Run Summary — ${DATE} — ${VERDICT}"

# Convert newlines to <br> for HTML email
HTML_BODY=$(echo "$SUMMARY" | sed 's/$/<br>/g' | tr -d '\n')
HTML_CONTENT="<div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; line-height: 1.6; color: #333;\"><p>Hi Daniel,</p><p>DanielsClaw just wrapped up a run. Here's the digest:</p><hr style=\"border: none; border-top: 1px solid #eee;\"/>${HTML_BODY}<hr style=\"border: none; border-top: 1px solid #eee;\"/><p style=\"color: #888; font-size: 12px;\">Automated summary from openclaw-secure pipeline</p></div>"

# Build email payload
jq -n \
  --arg to "$EMAIL_RECIPIENT" \
  --arg subject "$SUBJECT" \
  --arg html "$HTML_CONTENT" \
  --arg sender "DoNotReply@$ACS_SENDER_DOMAIN" \
  '{
    senderAddress: $sender,
    recipients: { to: [{ address: $to }] },
    content: {
      subject: $subject,
      html: $html
    }
  }' > /tmp/email_payload.json

# Send via ACS Email REST API using connection string auth
# Use curl with HMAC-SHA256 - compute signature per ACS spec
ACS_HOST=$(echo "$ACS_ENDPOINT" | sed 's|https://||' | sed 's|/$||')
ACS_DATE=$(date -u +"%a, %d %b %Y %H:%M:%S GMT")
ACS_PATH="/emails:send?api-version=2023-03-31"
CONTENT_HASH=$(openssl dgst -sha256 -binary /tmp/email_payload.json | base64)
STRING_TO_SIGN=$(printf "POST\n%s\n%s;%s;%s" "$ACS_PATH" "$ACS_DATE" "$ACS_HOST" "$CONTENT_HASH")
DECODED_KEY=$(echo "$ACS_ACCESS_KEY" | base64 -d)
SIGNATURE=$(printf "%s" "$STRING_TO_SIGN" | openssl dgst -sha256 -hmac "$DECODED_KEY" -binary | base64)

HTTP_STATUS=$(curl -s -o /tmp/acs_response.txt -w "%{http_code}" \
  -X POST \
  "${ACS_ENDPOINT}${ACS_PATH}" \
  -H "Content-Type: application/json" \
  -H "x-ms-date: ${ACS_DATE}" \
  -H "x-ms-content-sha256: ${CONTENT_HASH}" \
  -H "Authorization: HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${SIGNATURE}" \
  -d @/tmp/email_payload.json)

if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  OPERATION_ID=$(jq -r '.id // "unknown"' /tmp/acs_response.txt)
  echo "Email queued successfully (HTTP $HTTP_STATUS, operation: $OPERATION_ID)"
else
  echo "::warning::Email send failed (HTTP $HTTP_STATUS)"
  cat /tmp/acs_response.txt 2>/dev/null || true
fi

echo "=== Summary email step complete ==="
