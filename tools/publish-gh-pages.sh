#!/bin/bash

git commit -a
git push
git pull
if [ $? != 0 ]; then
  echo "git pull failed"
  exit 1
fi

python make_zip.py

rm -rf _site
git clone https://github.com/joeedh/faber-leaf.git _site

mkdir -p _site
if cd _site; then
  git checkout gh-pages
  git pull

  rm -rf scripts node_modules assets
  unzip -o -q ../app.zip
  
  rm -rf scripts/path.ux
  git submodule init
  git submodule update
  cd scripts/path.ux
  git pull origin master
  
  cd ../../
    
  git add *
  git commit -a -m "update gh-pages"
  git push
  cd ../
  rm -rf _site
else
  echo "Failed to create _site dir"
  exit 1
fi;