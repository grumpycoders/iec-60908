#!/bin/sh
gcc -o generate-test-patterns generate-test-patterns.c -O3

node index.js -v -i test1.raw -e test1.txt -t > test1-encoding.log
node index.js -v -i test2.raw -e test2.txt -t > test2-encoding.log
node index.js -v -i test3.raw -e test3.txt -t > test3-encoding.log
node index.js -v -i test4.raw -e test4.txt -t > test4-encoding.log

node read-bits.js -f -s -e -d -c test1.bin analyze test1.txt > test1-decoding.log
mv out.png test1.png
node read-bits.js -f -s -e -d -c test2.bin analyze test2.txt > test2-decoding.log
mv out.png test2.png
node read-bits.js -f -s -e -d -c test3.bin analyze test3.txt > test3-decoding.log
mv out.png test3.png
node read-bits.js -f -s -e -d -c test4.bin analyze test4.txt > test4-decoding.log
mv out.png test4.png
