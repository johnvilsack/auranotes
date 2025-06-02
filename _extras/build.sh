 #!/bin/bash

# Create zip from contents of ../src, excluding resource forks and parent folder

mkdir -p ../dist
cd ../src || exit 1
ditto -c -k --noqtn . ../dist/AuraNotes.zip
