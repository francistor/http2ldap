/*
HTTP server takes url of the form /attr=value/attr=value?filter=<ldap-filter>&scope=<scope> and sends the search
to an LDAP server. Response is codified in JSON as an object with array values for each attribute, in order to
support multivalued attributes
*/

/*
Launch
npm start -- -h 0.0.0.0 -p 8010 -b cn=read-only-admin,dc=example,dc=com -w password -l ldap://ldap.forumsys.com

Test with upstream
ldapsearch -H ldap://ldap.forumsys.com -x -D cn=read-only-admin,dc=example,dc=com -w password -b ou=mathematicians,dc=example,dc=com -s sub objectclass=*

*/

import express from 'express';
import ldap from 'ldapjs';

import { Command } from 'commander';
const commander = new Command();

// Process command line
commander
  .version('0.0.1', '-v, --version')
  .usage('[OPTIONS]...')
  .option('-h, --host <local ip address>', 'IP address to bind to. May also use HTTP2LDAP_HOST environment variable')
  .option('-p, --port <port>', 'HTTP listening port. May also use HTTP2LDAP_PORT environment variable')
  .option('-l, --ldap <ldap url>', 'ldap url. May also use HTTP2LDAP_LDAP_URL environment variable')
  .option('-b, --bind <bind dn>', 'bind dn. May also use HTTP2LDAP_BIND_DN environment variable')
  .option('-w, --password <bind password>', 'bind password. May also use HTTP2LDAP_BIND_PASSWORD environment variable')
  .option('-d, --debug', 'debug mode')
  .parse(process.argv);

const options = commander.opts();

const host = (options.host ? options.host : process.env.HTTP2LDAP_HOST);
const port = (options.port ? options.port : process.env.HTTP2LDAP_PORT);
const ldapUrl = (options.ldap ? options.ldap : process.env.HTTP2LDAP_LDAP_URL);
const bindDN = (options.bind ? options.bind : process.env.HTTP2LDAP_BIND_DN);
const bindPassword = (options.password ? options.password : process.env.HTTP2LDAP_BIND_PASSWORD);
const debug = options.debug;

// Setup ldap client
const client = ldap.createClient({
  url: [ldapUrl]
});

// Exit if bind error to ldap server
client.bind(bindDN, bindPassword, (err) => {
	if(err) throw err;
});

// Exit if connect error to ldap server
client.on('connectError', (err) => {
	if(err) throw err;
});

// Http server configuration
const app = express();
app.get('/*', (req, res, next) => {

	// Produce search base
	let searchBase = req.path.substring(1).split("/").reverse().join(",");
    
  let filter = decodeURI(req.query["filter"]);

  let scopeNumber = req.query["scope"];
  // This looks like a bug in ldapjs. scopes are received as numbers instead of strings
  let scope = "base";                     // Find one entry
  if (scopeNumber == "1") scope = "one";  // Find one level children
  if (scopeNumber == "2") scope = "sub";  // Find all subtree

  if(debug) console.log(`[DEBUG] [${new Date().toISOString()}] search ${searchBase} filter ${filter} scope ${scope}`);

  let opts = {
      filter: filter,
      scope: scope,
      attributes: []
  };

  client.search(searchBase, {}, (ldapErr, ldapRes) => {

      if(ldapErr){
          console.error(ldapErr);
          res.status(500).end();
          return;
      }

      // The array of entries to send back when we receive the 'end' event
      let entries = [];

      ldapRes.on('searchEntry', (entry) => {
        // The format of the received entry is
        // {... some irrelevant attributes, "objectName": dn, "attributes": [{"type": attribute name, "values": array of values}]}
        // This is converted to the format needed by ldapjs server API
        // {dn: dn, "attributes": {attriubte name: [values]}}
        // This is easier to parse in the API Gateway
        if(debug) console.log(`[INFO] [${new Date().toISOString()}] unparsed entry: `, JSON.stringify(entry.pojo));
        let resp = {
          dn: entry.pojo.objectName,
          attributes:{}
        };
        entry.pojo.attributes.forEach((attr) => {
            resp.attributes[attr.type] = attr.values;
        });

        if(debug) console.log(`[INFO] [${new Date().toISOString()}] pushing entry: `, JSON.stringify(resp));

        entries.push(resp);
      });

      // All entries available. Send final response
      ldapRes.on('end', (result) => {
        if(result.status !== 0){
          console.log(`[ERROR] [${new Date().toISOString()}] status: `, result.status);
          res.status(400).json({message: 'ldap status result was: ' + result.status}).end();
          return;
        }

        if(debug) console.log(`[DEBUG] [${new Date().toISOString()}] entries:`, JSON.stringify(entries));
        res.json(entries);
        next();
      });

      ldapRes.on('error', (err) => {
        if (err instanceof ldap.NoSuchObjectError){
          console.error(`[ERROR] [${new Date().toISOString()}] not found: ` + searchBase);
          res.status(400).json({message: 'not found: ' + searchBase}).end();
        } else {
          console.error(`[ERROR] [${new Date().toISOString()}] error: ` + err);
          res.status(500).json({message: err.message}).end();
        }
        
      });

      // Referals are not suported
      ldapRes.on('searchReference', (referral) => {
        console.log('referral: ' + referral.uris.join());
        console.error(`[ERROR] [${new Date().toISOString()}] referrals not supported`);
        res.status(400);
        res.json({"message": "referrals not supported"});
        res.end();
      });
    });
  });

// Start HTTP server
app.listen(port, host, () => {
	console.log(`[INFO] [${new Date().toISOString()}] http server listening on port ${port}`)
});
