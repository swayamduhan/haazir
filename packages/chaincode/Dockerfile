# Chaincode-as-a-Service image.
#
# The peer does not build this. We build and run it; the peer connects over
# gRPC to the address declared in the package's connection.json. Fabric 2.5
# supports this first-class, and it is what production deployments use.
#
# Built from build/chaincode/, a self-contained directory assembled by
# network/scripts/build-cc-package.sh with @haazir/shared vendored in — the
# npm workspace symlink does not exist inside the image.
FROM hyperledger/fabric-nodeenv:2.5

WORKDIR /usr/local/src

COPY package.json ./
COPY vendor ./vendor
RUN npm install --omit=dev

COPY dist ./dist

EXPOSE 9999

# CHAINCODE_ID is the package id, known only after the package is installed
# on a peer, so it is supplied at run time rather than baked in.
CMD ["sh", "-c", "./node_modules/.bin/fabric-chaincode-node server --chaincode-address=$CHAINCODE_SERVER_ADDRESS --chaincode-id=$CHAINCODE_ID"]
