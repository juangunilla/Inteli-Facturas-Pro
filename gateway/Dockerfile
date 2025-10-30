FROM node:18
WORKDIR /app
COPY . .
RUN npm install express node-fetch multer form-data
RUN printf '{"type":"module"}' > package.json
CMD ["node", "index.js"]
