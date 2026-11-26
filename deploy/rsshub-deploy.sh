#!/bin/sh
set -eu
case " ${SSH_ORIGINAL_COMMAND:-} " in
    *\ /usr/local/bin/rsshub-docker-deploy.sh\ --deploy-staging\ *)
        exec /usr/local/bin/rsshub-docker-deploy.sh --deploy-staging "${SSH_ORIGINAL_COMMAND##* }"
        ;;
esac
exec rsshub-service deploy
