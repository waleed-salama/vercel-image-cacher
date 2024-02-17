////////////////////////////////////////////////////////
// MAIN PARAMETERS
////////////////////////////////////////////////////////
const initialUrl = "https://waleed.dev";
const recursive = false; // if true, the crawler will visit all the links in the website (excluding external links)
const acceptHeaders = [
  "image/avif,image/webp,image/jpeg,image/png,image/*,*/*;q=0.8",
  "image/webp,image/jpeg,image/png,image/*,*/*;q=0.8",
  "image/jpeg,image/png,image/*,*/*;q=0.8",
  "image/png,image/*,*/*;q=0.8",
];
const logToFile = true;
const logToConsole = true;
const logFileName = "vercel-cacher.log";
const logLevel = "debug"; // error, warn, info, success, debug
const downloadImages = false; // if true, next two parameters are used
const { downloadCached, saveToDisk } = {
  downloadCached: true,
  saveToDisk: true,
};
////////////////////////////////////////////////////////

// Import required modules
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { backOff } = require("exponential-backoff");
const winston = require("winston");

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  success: 3,
  debug: 4,
};

// Define log colors
const colors = {
  error: "red",
  warn: "yellow",
  info: "blue",
  success: "green",
  debug: "white",
};

// Create a Winston logger
const logger = winston.createLogger({
  levels: levels,
  transports: [],
});

// Set log level based on the provided parameter
logger.level = logLevel;

// Add transports based on the provided parameters
if (logToFile) {
  logger.add(new winston.transports.File({ filename: logFileName }));
}

if (logToConsole) {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.simple()
      ),
    })
  );
}

// Define custom log colors
winston.addColors(colors);

const visitedUrls = new Set();
const allImageUrls = [];
const responseSizes = [];
const vercelServers = new Set();

// Function to visit a URL and extract image URLs
async function visitUrl(urlString, baseDomain) {
  // Fetch the HTML content of the page
  logger.debug(`Visiting URL: ${urlString}`);
  const response = await axios.get(urlString);
  const html = response.data;

  try {
    vercelServers.add(response.headers["x-vercel-id"].split("::")[0]);
  } catch (error) {
    // logger.error(`Failed to get vercel server for ${urlString}: ${error}`);
  }

  responseSizes.push(response.size);

  // Parse the HTML using Cheerio
  const $ = cheerio.load(html);

  // Extract image source URLs from <img> tags
  $("img").each((index, element) => {
    const imgSrc = $(element).attr("src");
    if (imgSrc) {
      logger.debug("Image URL:" + resolveUrl(imgSrc, urlString));
    }
  });

  // Extract image source URLs from srcset attributes
  $("img").each((index, element) => {
    const srcset = $(element).attr("srcset");
    if (srcset) {
      const imgUrls = srcset
        .split(",")
        .map((entry) => entry.trim().split(" ")[0]);
      imgUrls.forEach((imgUrl) => {
        logger.debug("Image URL:" + resolveUrl(imgUrl, urlString));
        allImageUrls.push(resolveUrl(imgUrl, urlString));
      });
    }

    const src = $(element).attr("src");
    if (src) {
      // Check for base64 encoded images
      if (src.startsWith("data:image")) return;
      logger.debug("Image URL: " + resolveUrl(src, urlString));
      allImageUrls.push(resolveUrl(src, urlString));
    }
  });

  // Extract URLs from anchor tags and visit them recursively if they belong to the same base domain

  if (recursive) {
    await Promise.allSettled(
      $("a").map(async (index, element) => {
        const href = $(element).attr("href").split("#")[0];
        if (href) {
          const resolvedUrl = resolveUrl(href, urlString);
          const parsedUrl = new URL(resolvedUrl);
          if (
            parsedUrl.hostname === baseDomain &&
            !visitedUrls.has(resolvedUrl)
          ) {
            visitedUrls.add(resolvedUrl);
            await visitUrl(resolvedUrl, baseDomain, visitedUrls);
          } else if (parsedUrl.hostname !== baseDomain) {
            logger.debug(
              `Skipping external URL: ${resolvedUrl}. Hostname: ${parsedUrl.hostname}, Base domain: ${baseDomain}\n\n`
            );
          } else if (visitedUrls.has(resolvedUrl)) {
            logger.debug(`Skipping already visited URL: ${resolvedUrl}\n\n`);
          } else {
            logger.debug(`Skipping URL for unknown reason: ${resolvedUrl}\n\n`);
          }
        }
      })
    );
  }
}

// Function to resolve relative URLs to absolute URLs
function resolveUrl(href, baseUrl) {
  return url.resolve(baseUrl, href);
}

const cachedImages = [];
const downloadedImages = [];
const fileSizes = [];

async function fetchImages(acceptHeader) {
  if (downloadImages) {
    try {
      fs.mkdirSync("./images");
    } catch (err) {
      if (err.code !== "EEXIST") {
        logger.error(err);
      }
    }
  }

  // Set the Accept header to specify the image formats you accept
  //   const acceptHeader =
  //     "image/avif,image/webp,image/jpeg,image/png,image/*,*/*;q=0.8";

  const retryOptions = {
    retries: 5, // Maximum number of retry attempts
    maxDelay: 30000, // Maximum delay between retries (in milliseconds)
    factor: 2, // Factor by which the delay increases after each attempt
    jitter: "full", // Add jitter to the delay
    onError: (error, attemptNumber) => {
      logger.error(`Attempt ${attemptNumber} failed: ${error.message}`);
    },
  };

  return Promise.allSettled(
    allImageUrls.map(async (imgUrl) => {
      try {
        logger.debug(`Checking HEAD ${imgUrl}`);

        // Define a function to make the Axios request with retries - only head to get the X-Vercel-Cache header
        const headImage = async () => {
          return axios.head(imgUrl, {
            headers: {
              Accept: acceptHeader, // Include the Accept header with the specified image formats
            },
          });
        };

        // Use exponential backoff to retry the request on ECONNRESET errors
        const headResponse = await backOff(headImage, retryOptions);

        try {
          vercelServers.add(headResponse.headers["x-vercel-id"].split("::")[0]);
        } catch (error) {
          // logger.error(`Failed to get vercel server for ${imgUrl}: ${error}`);
        }

        // Extract the X-Vercel-Cache header
        const cacheHeader = headResponse.headers["x-vercel-cache"];
        if (cacheHeader === "HIT") {
          logger.success(`File ${imgUrl} is cached.`);
          cachedImages.push(imgUrl);
          if (!downloadCached) return;
        } else {
          logger.warn(`File ${imgUrl} is not cached.`);
        }

        if (downloadImages) {
          logger.debug(`Downloading ${imgUrl}`);
          // Define a function to make the Axios request with retries - download the actual image
          const downloadImage = async () => {
            return axios.get(imgUrl, {
              headers: {
                Accept: acceptHeader, // Include the Accept header with the specified image formats
              },
              responseType: "arraybuffer", // Set responseType to arraybuffer to receive binary data
            });
          };

          // Use exponential backoff to retry the request on ECONNRESET errors
          const response = await backOff(downloadImage, retryOptions);

          // Extract the file type from the Content-Type header
          const contentType = response.headers["content-type"];
          const fileType = contentType.split("/")[1];

          // Extract the filename from the URL and width from the query parameters
          const filename = imgUrl.split("/").pop();
          // const width = imgUrl.split("&w=")[1].split("&")[0];

          // Construct the final filename
          const finalFilename = `${filename}.${fileType}`;
          // const finalFilename = `${width}_${filename}.${fileType}`;

          downloadedImages.push(finalFilename);
          fileSizes.push(response.data.length);
          logger.warn(`Downloaded ${finalFilename}`);

          if (saveToDisk) {
            const filePath = path.join(__dirname, "images", finalFilename);
            try {
              const stats = fs.statSync(filePath);
              if (stats.size === response.data.length) {
                logger.debug(
                  `File ${finalFilename} already exists with the same size. Skipping...`
                );
                return;
              }
            } catch (error) {
              // File does not exist, continue with downloading
            }

            // Write the image data to a file
            fs.writeFileSync(
              path.join(__dirname, "images", finalFilename),
              response.data
            );
          }
        }
      } catch (error) {
        logger.error(`Failed to download ${imgUrl}: ${error}`);
      }
    })
  );
}

// Start visiting the initial URL
const parsedInitialUrl = new URL(initialUrl);
visitedUrls.add(initialUrl);

async function main() {
  const startingTime = new Date().getTime();
  await visitUrl(initialUrl, parsedInitialUrl.hostname);
  //   logger.error("Sleeping for 3 seconds...");
  //   await new Promise((r) => setTimeout(r, 3000));
  logger.info("Visited " + visitedUrls.size + " unique pages.");
  //remove duplicates in the allImageUrls array
  const uniqueImageUrls = new Set(allImageUrls);
  allImageUrls.length = 0;
  allImageUrls.push(...uniqueImageUrls);
  //////////////////////////
  logger.info("Total image urls: " + allImageUrls.length);
  logger.info("Processing image urls...");
  await Promise.allSettled(
    acceptHeaders.map((acceptHeader) => fetchImages(acceptHeader))
  );

  //////////////////////////
  // Log the results
  //////////////////////////
  const endingTime = new Date().getTime();
  logger.info(
    "Visited " +
      visitedUrls.size +
      " urls:\n\t" +
      Array.from(visitedUrls).sort().join("\n\t")
  ); //sorts the urls ascending
  if (downloadImages)
    logger.info(
      "Done.\nDownloaded " +
        downloadedImages.length +
        " images (" +
        fileSizes.reduce((a, b) => a + b, 0) / 1000000 +
        " MB)"
    );
  logger.info(
    "Time elapsed: " + (endingTime - startingTime) / 1000 + " seconds."
  );
  logger.info("Already cached images: " + cachedImages.length);
  logger.info(
    "Uncached images: " +
      (allImageUrls.length * acceptHeaders.length - cachedImages.length)
  );
  logger.info("Vercel servers: " + Array.from(vercelServers).join(", "));
}

main();
