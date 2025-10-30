FROM node:18
WORKDIR /app
COPY . .
RUN npm install express
RUN printf '{"type":"module"}' > package.json
CMD ["node", "ai.js"]
