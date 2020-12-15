#!/usr/bin/env node
const program = require('commander');
const fs = require('vinyl-fs');
const map = require('map-stream');
const espree = require('espree');
const esquery = require('esquery');
const _get = require('lodash/get');
const _find = require('lodash/find');
const _cloneDeep = require('lodash/cloneDeep');
const { v4: uuidv4 } = require('uuid');
const toHump = require('./util.js');

const config = {
  routerName: 'router',
};

const depana = {
  rootTree: [],
  serviceTree: [],
  controllerTree: [],
  fileAst: null,
  _file: null,
  start: path => {
    const _this = depana;

    fs.src([path, '!node_modules/**/*'])
      .pipe(map((file, cb) => {
        _this.__start(file);
        cb(null, file);
      }))
      .on('end', () => {
        const { rootTree, controllerTree } = _this;
        const mapTree = rootTree.length === 0 ? controllerTree : rootTree;

        mapTree.forEach(root => {
          root.id = uuidv4();
          _this.__loop(controllerTree, root.children[0].key, root.children[0]);
        });
      });
  },
  __start: file => {
    const _this = depana;
    const { sourcePath, serviceName, controllerName, routerName } = config;

    _this.__rest();
    _this._file = file;
    if (file.path.indexOf(`${routerName}.js`) > -1) {
      _this.__analyzeRouter(file);
    } else if (file.path.indexOf(`${sourcePath}/${serviceName}`) > -1) {
      _this.serviceTree.push(..._this.__analyzeService(file, 'service'));
    } else if (file.path.indexOf(`${sourcePath}/${controllerName}s`) > -1) {
      _this.controllerTree.push(..._this.__analyzeController(file, 'controller'));
    } else {
      _this.__analyzeService(file, 'service');
    }
  },
  __rest: () => {
    const _this = depana;
    _this.rootTree = [];
    _this.serviceTree = [];
    _this.controllerTree = [];
    _this.fileAst = null;
    _this.file = null;
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
    _this.__formatAstToStruct(methodsAst);
    
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
    const calleeAstNodes = esquery(node, 'ExpressionStatement>CallExpression>.callee:has(\
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
    const calleeThisAstNodes = esquery(node, 'ExpressionStatement>CallExpression>.callee:has(\
      [object.type="ThisExpression"][property.name!="ctx"][property.name!="logger"][property.name!="service"][property.name!="fengdie"][property.name!="proxy"][property.name!="drm"]\
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
      [property.name="fengdie"][object.type="ThisExpression"]\
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

      console.log('>>>>>', node);
    });
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
    if (!children) return;
    node.children = _cloneDeep(children);
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const { key: child_key } = child;
      if (child_key.indexOf(`.${serviceName}.`) > -1) {
        __loop(serviceTree, child_key, child);
      } else if (child_key.indexOf(`.${controllerName}.`) > -1) {
        __loop(controllerTree, child_key, child);
      }
      child.id = uuidv4();
      child.collapsed = true;
    }
  },
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
  .action(params => {
    const {
      path = `${__dirname}/../test/class.js`,
      project_name = 'wealthbffweb',
      source_path = 'app',
      controller_name = 'controller',
      service_name = 'service',
    } = params || {};

    config.controllerName = controller_name;
    config.serviceName = service_name;
    config.sourcePath = source_path;
    config.projectName = project_name;
    config.path = path;

    depana.start(path);
  });

  program.parse(process.argv);