tsc -p ./
clear
clear
# $1: host
# $2: port
# $3: resource
./../node/out/Release/node ./out/mainclient.js $1 $2 $3
