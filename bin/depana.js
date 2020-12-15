#!/usr/bin/env node
const program = require('commander');
const fs = require('vinyl-fs');
const map = require('map-stream');
const inquirer = require('inquirer');
const espree = require('espree');
const esquery = require('esquery');
const _get = require('lodash/get');
const _find = require('lodash/find');
const _cloneDeep = require('lodash/cloneDeep');
const { v4: uuidv4 } = require('uuid');
const toHump = require('./util.js');
const server = require('./server.js');
const ffs = require('fs');

let config = {
  routerName: 'router',
  port: 3000,
};

const depana = {
  rootTree: [],
  serviceTree: [],
  controllerTree: [],
  fileAst: null,
  _file: null,
  start: (path, isTest = false) => {
    const _this = depana;

    fs.src([path, '!node_modules/**/*'])
      .pipe(map((file, cb) => {
        _this.__start(file, isTest);
        cb(null, file);
      }))
      .on('end', () => {
        const { rootTree, controllerTree } = _this;
        const { projectName, port } = config;

        const mapTree = rootTree.length === 0 ? controllerTree : rootTree;
        mapTree.forEach(root => {
          root.id = uuidv4();

          if (rootTree.length === 0) {
            _this.__loop(controllerTree, root.key, root);
          } else {
            const childNode =  _get(root, 'children[0]', null);
            _this.__loop(controllerTree, childNode.key, childNode);
          }
        });

        const writeStream = ffs.createWriteStream(`${__dirname}/../static/result.json`);
        writeStream.write(JSON.stringify({
          key: projectName,
          children: mapTree,
          id: uuidv4(),
          style: {
            fill: '#28d24d',
          },
        }));
        server(port);
      });
  },
  __start: (file, isTest = false) => {
    const _this = depana;
    const { sourcePath, serviceName, controllerName, routerName } = config;
    _this._file = file;

    if (isTest) {
      _this.__analyzeService(file, 'service');
      return;
    }

    if (file.path.indexOf(`${routerName}.js`) > -1) {
      _this.__analyzeRouter(file);
    } else if (file.path.indexOf(`${sourcePath}/${serviceName}`) > -1) {
      _this.serviceTree.push(..._this.__analyzeService(file));
    } else if (file.path.indexOf(`${sourcePath}/${controllerName}s`) > -1) {
      _this.controllerTree.push(..._this.__analyzeController(file));
    } else if (file.path.indexOf(`${sourcePath}/${controllerName}`) > -1) {
      _this.controllerTree.push(..._this.__analyzeController(file));
    }
  },
  __analyzeRouter: file => {
    const _this = depana;
    const fileText = file.contents.toString();
    const regexpRpc = /(?!=\')[a-zA-Z0-9.]+(?=\'\,)/gm;
    const regexpPath = /(?!=\,[\s]*)[a-zA-Z0-9.]+(?=\))/gm;

    const rpcList = fileText.match(regexpRpc);
    const pathList = fileText.match(regexpPath);

    // 校验一波
    if (rpcList.length != pathList.length) return;

    _this.rootTree = rpcList.map((rpc, index) => ({
      key: rpc,
      children: [{
        key: pathList[index],
      }],
    }));
  },
  __analyzeController: file => {
    const _this = depana;
    return _this.__analyzeService(file);
  },
  __analyzeService: file => {
    const _this = depana;
    
    _this.fileAst = espree.parse(file.contents.toString(), { ecmaVersion: 9 });
    // 初步获取文件中的所有方法
    let methodsAst = _this.__getMethodAst(_this.fileAst);
    // 获取每个方法中的业务调用
    methodsAst = methodsAst.map(_this.__queryAst);
    // 格式化成统一的数据结构
    return _this.__formatAstToStruct(methodsAst);
  },
  __getMethodAst: ast => {
    // 判断文件是class还是function
    let methodsAst = esquery(ast, 'ClassDeclaration > ClassBody > MethodDefinition');
    if (methodsAst.length === 0) {
      methodsAst = esquery(ast, 'ExpressionStatement>AssignmentExpression:has([left.object.name="exports"]) :matches(FunctionExpression, ArrowFunctionExpression)');
    }

    return methodsAst;
  },
  __queryAst: node => {
    // 核心代码，匹配符合业务规则的selector
    const _this = depana;

    /**
     * 选择所有callee
     * ctx.[service|drm|proxy].[...string]()形式
     * this.ctx.[service|drm|proxy].[...string]()形式
     * const { service } = this; service.[...string]()形式
     * this.[service|drm|proxy].[...string]()形式
     */
    const calleeAstNodes = esquery(node, 'CallExpression>.callee:has(\
      [property.name="service"][object.name="ctx"],\
      [property.name="service"][object.property.name="ctx"],\
      [property.name="service"][object.type="ThisExpression"],\
      [object.name="service"],\
      [property.name="service"],\
      [property.name="drm"][object.name="ctx"],\
      [property.name="drm"][object.property.name="ctx"],\
      [property.name="drm"][object.type="ThisExpression"],\
      [property.name="proxy"][object.name="ctx"],\
      [property.name="proxy"][object.property.name="ctx"],\
      [property.name="proxy"][object.type="ThisExpression"]\
    ):not([object.callee])');

    /**
     * this.[method != 'ctx|service|drm|proxy|fengdie']
     */
    const calleeThisAstNodes = esquery(node, 'CallExpression>.callee:has(\
      [object.type="ThisExpression"][property.name!="ctx"][property.name!="logger"][property.name!="service"][property.name!="fengdie"][property.name!="proxy"][property.name!="drm"][property.name!="success"][property.name!="throw"]\
    )');

    /**
     * fengdie MemberExpression
     * this.ctx.fengdie.xx
     * ctx.fengdie.xx
     * xx(this.ctx.fengdie.yy)
     * xx(ctx.fengdie.yy)
     * this.fengdie.yy
     */
    const fengdieDeclareAstNodes = esquery(node, 'MemberExpression:has(MemberExpression :has(\
      [property.name="fengdie"][object.name="ctx"],\
      [property.name="fengdie"][object.property.name="ctx"],\
      [property.name="fengdie"][object.type="ThisExpression"],\
      [property.name="fengdie"][object.property.name="app"],\
      [property.name="fengdie"][object.name="app"]\
    ))');

    return {
      methodName: _get(node, 'key.name', '') || 
        _get(...esquery(_this.fileAst, 'AssignmentExpression .left:has([object.name="exports"])'), 'property.name', ''),
      callee: [
        ...calleeAstNodes,
        ...calleeThisAstNodes,
        ...fengdieDeclareAstNodes,
      ],
    };
  },
  __formatAstToStruct: nodes => {
    const _this = depana;
    const { serviceName, controllerName, sourcePath } = config;

    nodes.forEach(node => {
      const { methodName, callee } = node || {};

      if (methodName) {
        while(callee.length) {
          let ast = callee.pop();
          let calleeName = '';
          let shouldNextStep = false;
  
          // 拼接xx.yy.zz
          do {
            const tempName = _get(ast, 'property.name', '')
              || _get(ast, 'name', '')
              || (_get(ast, 'type', '') === 'ThisExpression' ? 'this' : '');
          
            if (tempName) {
              calleeName = calleeName ? `${tempName}.${calleeName}` : tempName;
            } else {
              shouldNextStep = true;
              break;
            }
            ast = ast.object;
          } while(ast)

          // 特殊处理this.xx();
          if (!shouldNextStep) {
            const calleeNameStrList = calleeName.split('.');
            if (calleeNameStrList.length === 2) {
              const tempName = _this.__getFormatPath(calleeNameStrList[1]);
              if (tempName) {
                calleeName = tempName;
              }
            }
          }

          // 统一格式化
          calleeName = calleeName.replace(new RegExp(`(.*(?=${serviceName}\\.))`), `${sourcePath}.`);
          calleeName = calleeName.replace(new RegExp(`(.*(?=${controllerName}\\.))`), `${sourcePath}.`);
          calleeName = calleeName.replace(/(.*(?=drm\.))/, `${sourcePath}.`);
          calleeName = calleeName.replace(/(.*(?=fengdie\.))/, `${sourcePath}.`);
          calleeName = calleeName.replace(/(.*(?=proxy\.))/, `${sourcePath}.`);

          node.children ?
            node.children.push({ key: calleeName }) :
            node.children = [{ key: calleeName }];
        }
      }

      node.key = node.methodName;
      const tempName = _this.__getFormatPath(node.methodName);
      if (tempName) {
        node.key = tempName;
      }
      Reflect.deleteProperty(node, 'methodName');
      Reflect.deleteProperty(node, 'callee');
    });

    return nodes;
  },
  __getFormatPath: name => {
    const _this = depana;
    const { projectName, sourcePath, controllerName } = config;

    const regexp = new RegExp(`(?!=${projectName}\\/)(${sourcePath}\\S+)(?=(\\.js|\\.ts))`, 'g');
    const tempPathName = _this._file.path.match(regexp);
    if (tempPathName && tempPathName.length === 1) {
      return `${toHump(tempPathName[0])}/${name}`.split('/').join('.').replace(`.${controllerName}s.`, `.${controllerName}.`);
    }

    return null;
  },
  __loop: (tree, key, node) => {
    const _this = depana;
    const { __loop, serviceTree, controllerTree } = _this;
    const { serviceName, controllerName } = config;

    const page = _find(tree, { key });
    const { children } = page || {};
    node.id = uuidv4();
    node.collapsed = true;
    node.style = {
      fill: _this.__getColor(key),
    }
    if (!children) return;
    node.children = _cloneDeep(children);
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const { key: childKey } = child;
      if (childKey.indexOf(`.${serviceName}.`) > -1) {
        __loop(serviceTree, childKey, child);
      } else if (childKey.indexOf(`.${controllerName}.`) > -1) {
        __loop(controllerTree, childKey, child);
      }
      child.id = uuidv4();
      child.collapsed = true;
      child.style = {
        fill: _this.__getColor(childKey),
      };
    }
  },
  __getColor: str => {
    const { controllerName, serviceName } = config;

    if (str.indexOf('.proxy.') > -1) {
      return '#808080';
    }
    
    if (str.indexOf('.fengdie.') > -1) {
      return '#ffff00';
    }

    if (str.indexOf('.drm.') > -1) {
      return '#ffc0cb';
    }
    
    if (str.indexOf(`.${serviceName}.`) > -1) {
      return '#008000';
    }
    
    if (str.indexOf(`.${controllerName}.`) > -1 ) {
      return '#0000ff';
    }

    return '#eff4ff';
  }
};

program.version(require(`${__dirname}/../package.json`).version);
program
  .command('go')
  .alias('g')
  .description('静态解析eggjs项目中的引用关系')
  .option('-p, --path <path>', '项目根目录')
  .option('-pn, --project_name <project_name>', '项目名称 --正则匹配用')
  .option('-sp, --source_path <source_path>', '存放controller/router/service的路径')
  .option('-cn, --controller_name <controller_name>', 'controller的名称')
  .option('-sn, --service_name <service_name>', 'service的名称')
  .option('-po, --port <port>', '端口')
  .action(params => {
    const {
      path,
      project_name = 'wealthbffweb',
      source_path = 'app',
      controller_name = 'controller',
      service_name = 'service',
      port = 3000,
    } = params || {};

    config = {
      ...config,
      port,
      path,
      projectName: project_name,
      sourcePath: source_path,
      serviceName: service_name,
      controllerName: controller_name,
    };

    if (!path) {
      inquirer.prompt([{
        type: 'input',
        name: 'path',
        message: '请您输入项目根目录',
        validate: input => {
          if (!input) return '不能为空';
          return true;
        },
      }]).then(({ path }) => {
        config.path = path;
        depana.start(`${path}/${source_path}/**/*.js`);
      });

      return;
    }

    depana.start(`${path}/${source_path}/**/*.js`);
  });

program
  .command('test')
  .alias('t')
  .description('测试')
  .action(params => {
    const {
      path = `${__dirname}/../test/class.js`,
      project_name = 'wealthbffweb',
      source_path = 'app',
      controller_name = 'controller',
      service_name = 'service',
      port = 3000,
    } = params || {};

    config = {
      ...config,
      path,
      port,
      projectName: project_name,
      sourcePath: source_path,
      serviceName: service_name,
      controllerName: controller_name,
    };

    depana.start(path, true);
  });

program.parse(process.argv);
