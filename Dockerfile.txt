# Use the lightweight Node 18 image (matches your engines config)
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the bot code
COPY . .

# Expose the port (Northflank needs to know this)
EXPOSE 8080

# Start the bot
CMD ["node", "index.js"]
