# SPDX-License-Identifier: GPL-3.0-or-later
# Apache HTTPS front end. Terminates TLS and proxies to the app container.
# Runs as an unprivileged user (set in docker-compose) on ports 8443/8080.
FROM httpd:2.4-alpine
# Drop the stock port-80 listener and the default access log (which records
# query strings); sonoforms.conf defines its own. tzdata makes TZ in .env work.
# apk upgrade brings in security updates for the base image's packages.
RUN apk upgrade --no-cache \
 && apk add --no-cache openssl tzdata \
 && sed -i -e '/^Listen 80[[:space:]]*$/s/^/# (see sonoforms.conf) /' \
           -e '/^[[:space:]]*CustomLog /s/^/# /' /usr/local/apache2/conf/httpd.conf \
 && echo 'Include conf/sonoforms.conf' >> /usr/local/apache2/conf/httpd.conf
COPY sonoforms.conf /usr/local/apache2/conf/sonoforms.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && chown www-data:www-data /usr/local/apache2/logs
# Unprivileged by default too (docker-compose sets the exact user).
USER www-data
EXPOSE 8443 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["httpd-foreground"]
