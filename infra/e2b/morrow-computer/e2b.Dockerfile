# Morrow's computer: the E2B template of profile morrow.computer v1 (ADR-0029 item 1; build
# order PR 8). Python and its data libraries from Debian's own signed packages; this recipe
# adds no browser, network tool, compiler or secret. Model-written code runs as the non-root
# user `agent`, with /usr/bin/python3 in isolated mode (packages/policy/src/runtime-computer.ts
# computerProfile.command). The owner builds it with the owner's own E2B login (README.md);
# Claude, CI and the Workers never build it. Any change here needs a new build, a new
# template.json record and a new qualification (build order PR 9).
#
# E2B's builder changes the image around these steps (github.com/e2b-dev/infra, the
# orchestrator's template builder, read 2026-10-24). Before them it clears root's password,
# installs sudo, openssh-server (allowing root and empty-password logins), curl, socat, git,
# iptables and other tools, and adds the user `user` with an empty password and passwordless
# sudo. After them it sets that password and sudo again and makes /usr/local writable by all.
# Egress is denied by E2B's platform at creation, not by this image. The step before
# `USER agent` closes the ways from `agent` to root that this leaves.
FROM debian:trixie-slim

# Debian's packages only (apt verifies them against Debian's archive keys); nothing from pip.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 \
      python3-numpy \
      python3-pandas \
      python3-matplotlib \
      python3-openpyxl \
      python3-xlsxwriter \
      fonts-dejavu-core \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# The agent user, without sudo or any extra group, and its three directories (work, input,
# output), readable by nobody else.
RUN useradd --create-home --home-dir /home/agent --shell /bin/bash --user-group agent \
 && install -d -o agent -g agent -m 0700 /home/agent/work /home/agent/input /home/agent/output

# Charts render to files only.
RUN printf 'backend: Agg\n' > /etc/matplotlibrc

# No way from `agent` to root (ADR-0029 item 3: envd's token must be unreadable by agent).
# This runs as root after E2B's provisioning, which therefore cannot undo it, and E2B's
# finalize step reinstalls none of it. Root's password is locked. su and sudo run only for
# root and its group, which agent is not in, so agent cannot reach `user` and its
# passwordless sudo either. sshd is removed. Each result is checked, and the build stops if
# one did not take.
RUN passwd -l root \
 && dpkg-statoverride --update --add root root 4750 /usr/bin/su \
 && dpkg-statoverride --update --add root root 4750 /usr/bin/sudo \
 && if dpkg-query -W -f='${Status}' openssh-server 2>/dev/null | grep -q 'ok installed'; then \
      DEBIAN_FRONTEND=noninteractive apt-get purge -y openssh-server; \
    fi \
 && test "$(passwd -S root | cut -d' ' -f2)" = L \
 && test "$(stat -c %a:%U:%G /usr/bin/su)" = 4750:root:root \
 && if [ -e /usr/bin/sudo ]; then test "$(stat -c %a:%U:%G /usr/bin/sudo)" = 4750:root:root; fi \
 && test ! -e /usr/sbin/sshd \
 && test "$(id -nG agent)" = agent

USER agent
WORKDIR /home/agent/work
