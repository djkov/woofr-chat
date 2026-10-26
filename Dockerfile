FROM nginxinc/nginx-unprivileged:1.27-alpine

USER root

# Remove default config and default content
RUN rm /etc/nginx/conf.d/default.conf \
    && rm -rf /usr/share/nginx/html/*

COPY nginx.conf /etc/nginx/conf.d/woofr.conf
COPY index.html app.js omemo.js history.js media.js richtext.js styles.css LICENSE /usr/share/nginx/html/
COPY vendor/strophe.umd.min.js vendor/libsignal.min.js \
     vendor/strophe.js-LICENSE.txt vendor/libsignal-LICENSES.txt /usr/share/nginx/html/vendor/

RUN chown -R nginx:nginx /usr/share/nginx/html \
    && find /usr/share/nginx/html -type f -exec chmod 444 {} +

USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
