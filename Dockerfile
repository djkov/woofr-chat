FROM nginxinc/nginx-unprivileged:1.27-alpine

USER root

# Remove default config and default content
RUN rm /etc/nginx/conf.d/default.conf \
    && rm -rf /usr/share/nginx/html/*

COPY nginx.conf /etc/nginx/conf.d/woofr.conf
COPY index.html /usr/share/nginx/html/index.html

RUN chown nginx:nginx /usr/share/nginx/html/index.html \
    && chmod 444 /usr/share/nginx/html/index.html

USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
