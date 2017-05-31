const argv = require('minimist')(process.argv.slice(2));
const fs = require('fs');
const yaml = require('../lib/yaml');
const _ = require('lodash');
const compareUrls = require('compare-urls');
const normalizeUrl = require('normalize-url');
const table = require('text-table');
const inquirer = require('inquirer');
const fetch = require('../lib/fetch');
const distanceInWordsToNow = require('date-fns/distance_in_words_to_now');
const newwork = require('..');
const path = require('path');
const createHTML = require('create-html');
const http = require('http');
const opn = require('opn');

const helpText = `
  Usage: newwork <command> [options]

  Commands:
    <default>                   Run 'newwork serve'
    serve                       Scrape, update, and serve a new-work page
    build                       Scrape, update, and save a new-work page to disk
    add [url]                   Add an URL to your list of sites
    remove [url]                Remove an URL from your list of sites
    list                        List all sites in your new-work page

  Available options:
    -i, --input <filename>      Input YAML file [default: sites.yaml]
    -o, --output <filename>     Output HTML file [default: sites.html]
    -l, --lockfile <filename>   Lockfile location [default: sites.lock]
    -p, --port=<n>              Bind 'newwork serve' to a port [default: 3030]
    -h, --help                  Print usage
`;

var h = argv.h || argv.help;

argv.input = argv.input || './sites.yaml';
argv.output = argv.output || './sites.html';
argv.lockfile = argv.lockfile || './sites.lock';
argv.port = argv.port || 3030;

if (h) {
  help();
  exit();
}

var cmd = argv._.shift();

switch (cmd) {
  case 'list':
    list();
    break;
  case 'remove':
    remove();
    break;
  case 'add':
    add();
    break;
  case 'build':
    build();
    break;
  case 'serve':
  case undefined:
    serve();
    break;
  default:
    exit(`command ${cmd} not found`);
}

function help() {
  console.log(helpText);
  exit();
}

function exit(err) {
  if (err) {
    console.log(err.toString());
    process.exit(1);
  }
  process.exit(0);
}

function list() {
  ls(argv.input, (err, sites) => {
    if (err) exit(err);
    console.log(table(sites));
    exit();
  });

  function ls(input, cb) {
    yaml.read(input, (err, data) => {
      if (err) return cb(err, null);
      cb(
        null,
        _.map(data.sites, o => {
          return _.values(_.omit(o, ['selector']));
        })
      );
    });
  }
}

function remove() {
  var url = argv._.shift();
  prompt = !url
    ? prompt
    : cb => {
        cb(null, url);
      };

  prompt((err, url) => {
    if (err) exit(err);
    removeEntry(argv.input, url, err => {
      if (err) exit(err);
      console.log(`Removed ${url} from ${argv.input}`);
      exit();
    });
  });

  function prompt(cb) {
    inquirer
      .prompt([
        {
          type: 'input',
          name: 'url',
          message: 'URL'
        }
      ])
      .then(answers => {
        cb(null, answers.url);
      })
      .catch(err => {
        cb(err, null);
      });
  }

  function removeEntry(input, url, cb) {
    yaml.read(input, (err, data) => {
      if (err) return cb(err);
      if (
        !_.find(data.sites, site => {
          return compareUrls(site.url, url);
        })
      ) {
        return cb(new Error(`site ${url} not found`));
      }
      data.sites = _.reject(data.sites, site => {
        return compareUrls(site.url, url);
      });
      yaml.write(input, data, cb);
    });
  }
}

function add() {
  var url = argv._.shift();

  prefetch = url
    ? validate
    : (_, cb) => {
        cb(null);
      };

  prefetch(url, (err, lastModifiedDate, $) => {
    if (err) exit(err);
    var site = {
      url: url,
      lastModifiedDate: lastModifiedDate,
      $: $
    };
    inquirer
      .prompt([
        {
          type: 'input',
          name: 'site',
          message: 'URL',
          filter: function(url) {
            var cb = this.async();
            validate(url, (err, lastModifiedDate, $) => {
              if (err) return cb(err);
              cb(null, {
                url: url,
                lastModifiedDate: lastModifiedDate,
                $: $,
                toString: () => {
                  return url;
                }
              });
            });
          },
          when: function() {
            return !site.url;
          }
        },
        {
          type: 'input',
          name: 'name',
          message: 'Name',
          default: answers => {
            var $ = site.$ || answers.site.$;
            return $('title').text();
          }
        },
        {
          type: 'confirm',
          name: 'lastModified',
          message: answers => {
            var lastModifiedDate =
              site.lastModifiedDate || answers.site.lastModifiedDate;
            return `Was the site last modified ${distanceInWordsToNow(lastModifiedDate)} ago?`;
          },
          when: answers => {
            var lastModifiedDate =
              site.lastModifiedDate || answers.site.lastModifiedDate;
            return lastModifiedDate;
          }
        },
        {
          type: 'input',
          name: 'selector',
          message: `Choose an element selector to diff for changes`,
          when: answers => {
            var lastModifiedDate =
              site.lastModifiedDate || answers.site.lastModifiedDate;
            return !lastModifiedDate || !answers.lastModified;
          },
          validate: (selector, answers) => {
            var $ = site.$ || answers.site.$;
            return $.html($(selector).first())
              ? true
              : `$('${selector}') didn't return any elements, try again.`;
          }
        }
      ])
      .then(answers => {
        var entry = {
          name: answers.name,
          url: site.url || answers.site.url
        };
        if (answers.selector) entry.selector = answers.selector;

        addEntry(argv.input, entry, err => {
          if (err) exit(err);
          console.log(`Added ${url} to ${argv.input}`);
          exit();
        });
      })
      .catch(err => {
        exit(err);
      });
  });

  function addEntry(input, opts, cb) {
    yaml.read(input, (err, data) => {
      if (err) return cb(err);
      if (
        _.find(data.sites, site => {
          return compareUrls(site.url, opts.url);
        })
      )
        return cb(new Error(`Site ${opts.url} already in ${argv.input}`));
      data.sites.push(opts);
      data.sites = _.sortBy(data.sites, 'name');
      yaml.write(input, data, cb);
    });
  }

  function validate(url, cb) {
    url = normalizeUrl(url, {
      stripFragment: false,
      stripWWW: false,
      removeTrailingSlash: false
    });
    fetch(url, cb);
  }
}

function build() {
  renderHTML(argv.input, argv.lockfile, (err, html) => {
    if (err) exit(err);
    fs.writeFile(argv.output, html, function(err) {
      if (err) exit(err);
      console.log(`Wrote New Work page to ${argv.output}`);
      exit();
    });
  });
}

function serve() {
  renderHTML(argv.input, argv.lockfile, (err, html) => {
    if (err) exit(err);
    http
      .createServer((req, resp) => {
        resp.end(html);
      })
      .listen(argv.port, err => {
        console.log(`Serving New Work page on localhost:${argv.port}`);
        opn(`http://localhost:${argv.port}`);
      });
  });
}

function renderHTML(input, lockfile, cb) {
  yaml.read(input, (err, input) => {
    if (err) return cb(err, null);
    var sites = input.sites;

    newwork.render(sites, lockfile, (err, body) => {
      if (err) return cb(err, null);

      fs.readFile(
        path.join(__dirname, '../views/default.css'),
        'utf8',
        (err, css) => {
          if (err) return cb(err, null);
          var cssTag = `<style type="text/css">
            ${css}
          </style>
          `;
          var html = createHTML({
            title: 'New Work',
            body: body,
            head: cssTag,
            lang: 'en'
          });
          cb(null, html);
        }
      );
    });
  });
}