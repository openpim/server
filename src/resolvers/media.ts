import Context from "../context"
import fs from "fs"
import path from "path"

const FILES_ROOT = process.env.FILES_ROOT!
const FONTS_DIR = path.join(FILES_ROOT, "/static/fonts")
const IMAGES_DIR = path.join(FILES_ROOT, "/static/images")

export default {
    Query: {
        getFonts: async (parent: any, args: any, context: Context) => {
            context.checkAuth()

            return formatFilesResponse(FONTS_DIR, "fonts", context)
        },
        getImages: async (parent: any, args: any, context: Context) => {
            context.checkAuth()

            return formatFilesResponse(IMAGES_DIR, "images", context)
        }
    }
}

function formatFilesResponse (dirPath: string, urlPrefix: string, context: Context) {
    try {
        if (!fs.existsSync(dirPath)) {
            throw new Error(`Folder not found: ${dirPath}, tenant: ${context.getCurrentUser()?.tenantId}`)
        }

        const files = fs.readdirSync(dirPath)
        const rows = files.map(file => ({
            name: file,
            url: `/static/${urlPrefix}/${file}`
        }))

        return { count: rows.length, rows }
    } catch (e) {
        throw new Error(`Error accessing files: ${urlPrefix}, tenant: ${context.getCurrentUser()?.tenantId}`)
    }
}
