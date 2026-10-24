# SPDX-License-Identifier: GPL-3.0-or-later
# Apache HTTPS front end. Terminates TLS and proxies to the app container.
FROM httpd:2.4-alpine
RUN apk add --no-cache openssl
COPY sonoforms.conf /usr/local/apache2/conf/sonoforms.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && echo 'Include conf/sonoforms.conf' >> /usr/local/apache2/conf/httpd.conf
ENTRYPOINT ["/entrypoint.sh"]
CMD ["httpd-foreground"]
