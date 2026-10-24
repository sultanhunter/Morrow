# Morrow's computer: the E2B template of profile morrow.computer v1 (ADR-0029 item 1; build
# order PR 8). Python and its data libraries from Debian's own signed packages, no browser, no
# network tool, no compiler, no secret. Model-written code runs as the non-root user `agent`,
# with /usr/bin/python3 in isolated mode (packages/policy/src/runtime-computer.ts
# computerProfile.command). The owner builds it with the owner's own E2B login (README.md);
# Claude, CI and the Workers never build it. Any change here needs a new build, a new
# template.json record and a new qualification (build order PR 9).
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

USER agent
WORKDIR /home/agent/work
