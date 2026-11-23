FROM docker.io/searxng/searxng:latest
# The upstream entrypoint creates settings.yml from this template and replaces
# its placeholder with a random secret on the first start of the config volume.
COPY settings.yml /usr/local/searxng/settings.template.yml
