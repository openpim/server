declare module 'promised-handlebars' {
    const promisedHandlebars: (hbs: any, options: { Promise: any }) => any
    export default promisedHandlebars
}

declare module 'q' {
    const Q: { Promise: any }
    export default Q
}
