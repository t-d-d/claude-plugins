#!/bin/bash
# SessionStart hook for aws-access. Asks the access endpoint for this
# session's AWS profiles and writes them to ~/.aws/config, then installs the
# AWS CLI if the machine has none.
#
#   ACCESS_URL         the endpoint's URL. Where it is not set, as on a
#                      laptop, the hook does nothing at all.
#   AWS_REGION         the region the profiles default to; us-east-1 if unset.
#   AWS_ACCESS_PREFIX  where a missing CLI is installed; /usr/local if unset.
#
# The request carries no token of its own. The environment's network secret
# adds one after the request has left the session's machine.
#
# What the hook prints joins the session's context: the config's first line,
# which names the profiles, and where AWS_PROFILE is set a line that says it
# is the default. It prints these again after a clear or a compaction, which
# rebuild the context without them.
#
# A failed fetch fails the hook, and Claude Code drops a failed hook's plain
# stdout. It does read the context out of a JSON answer whatever the exit
# code, so a failure prints its lines as one JSON line. Checked on Claude
# Code 2.1.330.
[ -n "${ACCESS_URL:-}" ] || exit 0

config=~/.aws/config
part=~/.aws/config.part

# The profiles come first. They are quick, and the session needs them even if
# the install below is cut short. The fetch gets ten seconds of the hook's 45,
# so an endpoint that never answers cannot hold the session until the hook is
# killed. Nothing but a whole, non-empty answer replaces the config, and the
# part file goes whichever way the hook ends.
status=0
failure=""
mkdir -p ~/.aws
trap 'rm -f "$part"' EXIT
if curl -fsS --max-time 10 "${ACCESS_URL%/}/config?region=${AWS_REGION:-us-east-1}" > "$part"; then
  if [ -s "$part" ]; then
    mv "$part" "$config" || { status=$?; failure="could not write ~/.aws/config"; }
  else
    status=1
    failure="the access endpoint answered with nothing"
    echo "aws-access: $failure" >&2
  fi
else
  status=$?
  failure="could not fetch the profiles (curl exit $status)"
fi
rm -f "$part"

lines=()
if [ -n "$failure" ]; then
  if [ -s "$config" ]; then
    lines+=("# aws: $failure; kept the config fetched earlier")
  else
    lines+=("# aws: $failure; there is no earlier config, so no profile will work")
  fi
fi
if [ -s "$config" ]; then
  lines+=("$(head -1 "$config" | tr -d '\000-\010\012-\037')")
  [ -z "${AWS_PROFILE:-}" ] || lines+=("# aws: default profile is $AWS_PROFILE; a bare aws call uses it")
fi

# The lines as one JSON string.
json_string() {
  local text line
  for line in "$@"; do
    line="${line//\\/\\\\}"
    line="${line//\"/\\\"}"
    line="${line//$'\t'/\\t}"
    text+="${text:+\\n}$line"
  done
  printf '"%s"' "$text"
}

if [ -z "$failure" ]; then
  printf '%s\n' "${lines[@]}"
else
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$(json_string "${lines[@]}")"
fi

install_cli() {
  local prefix="${AWS_ACCESS_PREFIX:-/usr/local}" arch tmp result
  [ "$(uname -s)" = Linux ] || return 1
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | aarch64) ;;
    *) return 1 ;;
  esac
  tmp="$(mktemp -d)" || return 1
  curl -fsSL -o "$tmp/awscliv2.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$arch.zip" \
    && unzip -q -o "$tmp/awscliv2.zip" -d "$tmp" \
    && "$tmp/aws/install" --install-dir "$prefix/aws-cli" --bin-dir "$prefix/bin" --update > /dev/null
  result=$?
  rm -rf "$tmp"
  return "$result"
}

# A failed install must not fail the hook: the profiles are still of use to
# a session that installs the CLI itself.
if ! command -v aws > /dev/null 2>&1; then
  install_cli || echo "aws-access: could not install the AWS CLI; continuing without it" >&2
fi
exit "$status"
