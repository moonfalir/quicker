tsc -p ./
clear
clear
# $1: host
# $2: port
# $3: key
# $4: cert
./../node/out/Release/node ./out/main.js $1 $2 $3 $4
