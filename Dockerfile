# apify/actor-node:24 ships apify SDK 3.7.2, which does NOT expose Actor.log
# (see src/main.js) -- kept in sync with the NBA/NHL/MLB Actors on purpose.
FROM apify/actor-node:24

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-audit --no-fund \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY . ./

CMD npm start --silent
