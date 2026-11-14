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
# The first line of the config names the profiles. The hook prints it, so it
# joins the session's context, and prints nothing else there.
[ -n "${ACCESS_URL:-}" ] || exit 0

# The profiles come first. They are quick, and the session needs them even if
# the install below is cut short. A refused request keeps the old config.
status=0
mkdir -p ~/.aws
if curl -fsS "${ACCESS_URL%/}/config?region=${AWS_REGION:-us-east-1}" > ~/.aws/config.part; then
  mv ~/.aws/config.part ~/.aws/config && head -1 ~/.aws/config
else
  status=$?
  rm -f ~/.aws/config.part
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
