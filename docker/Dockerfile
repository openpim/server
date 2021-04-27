FROM node:12

COPY ./src /server/src
COPY ./schema /server/schema
COPY ./package.json /server
COPY ./package-lock.json /server
COPY ./tsconfig.json /server
COPY ./docker/server_env /server/.env
COPY ./docker/start.sh /server/start.sh
	
WORKDIR /server
RUN npm install
RUN npm run build

RUN chmod +x /server/start.sh
                
EXPOSE 80

STOPSIGNAL SIGTERM

ENTRYPOINT /server/start.sh
