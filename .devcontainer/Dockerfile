# Sandbox for running Claude Code with --dangerously-skip-permissions.
# Based on Anthropic's reference devcontainer: outbound network is limited to an
# allowlist by init-firewall.sh, which runs on every container start.
FROM node:26

ARG TZ=Etc/UTC
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    aggregate \
    ca-certificates \
    curl \
    dnsutils \
    git \
    ipset \
    iproute2 \
    iptables \
    jq \
    less \
    procps \
    sudo \
    vim \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The base image's "node" user (uid 1000) runs everything. It gets sudo for the
# firewall script only, so code running in the container cannot undo the firewall.
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh \
  && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall \
  && chmod 0440 /etc/sudoers.d/node-firewall \
  && mkdir -p /workspace /commandhistory /home/node/.claude \
  && chown -R node:node /workspace /commandhistory /home/node/.claude

USER node

ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=$PATH:/home/node/.npm-global/bin
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Persist shell history in a volume.
RUN echo 'export PROMPT_COMMAND="history -a"; export HISTFILE=/commandhistory/.bash_history' >> /home/node/.bashrc

ENV SHELL=/bin/bash
WORKDIR /workspace
