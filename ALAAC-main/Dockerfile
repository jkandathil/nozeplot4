FROM python:3.10.14-slim
RUN apt-get update && apt-get install -y gcc libffi-dev g++ curl gnupg2 lsb-release wget

ARG NEXUS_PYPI_USER
ENV NEXUS_PYPI_USER=$NEXUS_PYPI_USER

ARG NEXUS_PYPI_PASSWD
ENV NEXUS_PYPI_PASSWD=$NEXUS_PYPI_PASSWD

ARG NEXUS_PYPI_REPO_URL
ENV NEXUS_PYPI_REPO_URL=$NEXUS_PYPI_REPO_URL

ARG PACKAGE_VERSION
ENV PACKAGE_VERSION=$PACKAGE_VERSION

WORKDIR /usr/app
COPY . .

RUN pip install poetry

# Setup Poetry
RUN poetry config repositories.cloudscent $NEXUS_PYPI_REPO_URL
RUN poetry config http-basic.cloudscent $NEXUS_PYPI_USER $NEXUS_PYPI_PASSWD

# Build
RUN poetry version $PACKAGE_VERSION
RUN poetry publish --build --repository cloudscent