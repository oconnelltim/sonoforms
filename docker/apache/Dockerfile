# SPDX-License-Identifier: GPL-3.0-or-later
# Apache HTTPS front end. Terminates TLS and proxies to the app container.
# Runs as an unprivileged user (set in docker-compose) on ports 8443/8080.
FROM httpd:2.4-alpine
# Drop the stock port-80 listener and the default access log (which records
# query strings); sonoforms.conf defines its own.
RUN apk add --no-cache openssl \
 && sed -i -e 's/^Listen 80$/# Listen 80 (see sonoforms.conf)/' \
           -e 's/^\([[:space:]]*CustomLog .*\)$/# \1/' /usr/local/apache2/conf/httpd.conf \
 && echo 'Include conf/sonoforms.conf' >> /usr/local/apache2/conf/httpd.conf
COPY sonoforms.conf /usr/local/apache2/conf/sonoforms.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
EXPOSE 8443 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["httpd-foreground"]
