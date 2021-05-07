var fs = require('fs')
const { generate } = require('build-number-generator')

console.log('Incrementing build revision...')
fs.readFile('src/version.ts',function(err,content) {
    if (err) throw err;

    let str = content.toString()
    const idx = str.indexOf('"buildRevision": "')
    const idx2 = str.indexOf('"', idx + 18)
    const rev = generate()
    str = str.substring(0, idx + 18) + rev + str.substring(idx2)

    fs.writeFile('src/version.ts',str,function(err){
        if (err) throw err
        console.log(`Current build revision: ` + rev)
    })
})